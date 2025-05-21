"""
Add Vector IDs to DynamoDB Table

This script adds Qdrant vector IDs to the existing DynamoDB table.
It takes each key from DynamoDB, computes the corresponding vector ID using the same
hashing function used in the notebook, and updates the DynamoDB item.

The script uses parallelization for efficiency and only adds vector IDs to items
that don't already have them.
"""

import boto3
import hashlib
import concurrent.futures
import time
from decimal import Decimal
from botocore.exceptions import ClientError

# Configuration
REGION = 'eu-west-1'
TABLE_NAME = 'photoViewer'
VECTOR_ID_FIELD = 'VectorId'  # Field name to store the vector ID
MAX_WORKERS = 10  # Number of parallel workers
BATCH_SIZE = 25   # Items per batch

# Initialize AWS clients
dynamodb = boto3.resource('dynamodb', region_name=REGION)
table = dynamodb.Table(TABLE_NAME)

def key_to_id(key: str) -> int:
    """Stable integer ID from SHA1(key) mod 1e18."""
    sha = hashlib.sha1(key.encode()).hexdigest()
    return int(sha, 16) % (10**18)

def update_item_with_vector_id(item):
    """Update a single DynamoDB item with its vector ID."""
    key = item.get('Key')
    if not key:
        print(f"⚠️ Item missing 'Key' field: {item}")
        return False
    
    # Skip if the item already has a vector ID
    if VECTOR_ID_FIELD in item:
        return False
    
    # Compute the vector ID
    vector_id = key_to_id(key)
    
    try:
        # Update the item in DynamoDB
        response = table.update_item(
            Key={'Key': key},
            UpdateExpression=f"SET {VECTOR_ID_FIELD} = :vid",
            ExpressionAttributeValues={':vid': Decimal(str(vector_id))},
            ReturnValues="UPDATED_NEW"
        )
        return True
    except ClientError as e:
        print(f"❌ Error updating item {key}: {e}")
        return False

def process_batch(batch):
    """Process a batch of items."""
    updated = 0
    for item in batch:
        if update_item_with_vector_id(item):
            updated += 1
    return updated

def main():
    start_time = time.time()
    print(f"🔍 Scanning DynamoDB table '{TABLE_NAME}'...")
    
    # Scan DynamoDB table
    paginator = dynamodb.meta.client.get_paginator("scan")
    items = []
    for page in paginator.paginate(TableName=TABLE_NAME):
        items.extend(page["Items"])
    
    total_items = len(items)
    print(f"📊 Found {total_items} items in DynamoDB.")
    
    # Check how many items already have vector IDs
    items_with_vector_id = sum(1 for item in items if VECTOR_ID_FIELD in item)
    items_to_update = total_items - items_with_vector_id
    
    print(f"ℹ️ {items_with_vector_id} items already have vector IDs.")
    print(f"🔄 {items_to_update} items need to be updated.")
    
    if items_to_update == 0:
        print("✅ All items already have vector IDs. Nothing to do.")
        return
    
    # Split items into batches
    batches = [items[i:i + BATCH_SIZE] for i in range(0, len(items), BATCH_SIZE)]
    total_batches = len(batches)
    
    print(f"⚙️ Processing {total_batches} batches with {MAX_WORKERS} workers...")
    
    # Process batches in parallel
    updated_count = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        future_to_batch = {executor.submit(process_batch, batch): i for i, batch in enumerate(batches)}
        
        for future in concurrent.futures.as_completed(future_to_batch):
            batch_index = future_to_batch[future]
            try:
                batch_updated = future.result()
                updated_count += batch_updated
                print(f"✅ Batch {batch_index + 1}/{total_batches} complete: updated {batch_updated} items.")
            except Exception as e:
                print(f"❌ Batch {batch_index + 1}/{total_batches} failed: {e}")
    
    elapsed_time = time.time() - start_time
    print(f"\n🎉 Done! Updated {updated_count} items in {elapsed_time:.2f} seconds.")

if __name__ == "__main__":
    main()
