"""data/ フォルダと Cloudflare R2 を同期する。

    python r2sync.py pull   R2 → data/   (収集の前に、前回までのデータを取ってくる)
    python r2sync.py push   data/ → R2   (収集の後に、変わったファイルだけ送る)

R2 では members/ の下に、data/ と同じ並びで置く。
    data/index.json            → members/index.json
    data/C22R8GLC/recent.json  → members/C22R8GLC/recent.json

必要な環境変数(GitHub の Secrets):
    R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT
"""

import hashlib
import json
import os
import sys
from pathlib import Path

import boto3

BUCKET = os.environ.get("R2_BUCKET", "supaken-data")
PREFIX = "members/"
DATA_DIR = Path(__file__).parent / "data"
MANIFEST = DATA_DIR / ".r2manifest.json"   # pull した時点の各ファイルの md5


def client():
    ep = os.environ["R2_ENDPOINT"].strip().rstrip("/")
    if ep.endswith("/" + BUCKET):        # バケット名まで貼られていても動くように
        ep = ep[: -len(BUCKET) - 1]
    return boto3.client(
        "s3",
        endpoint_url=ep,
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"].strip(),
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"].strip(),
        region_name="auto",
    )


def md5(data: bytes) -> str:
    return hashlib.md5(data).hexdigest()


def pull():
    s3 = client()
    manifest = {}
    count = 0
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=BUCKET, Prefix=PREFIX):
        for obj in page.get("Contents", []):
            rel = obj["Key"][len(PREFIX):]
            if not rel or rel.endswith("/"):
                continue
            body = s3.get_object(Bucket=BUCKET, Key=obj["Key"])["Body"].read()
            path = DATA_DIR / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(body)
            manifest[rel] = md5(body)
            count += 1
    DATA_DIR.mkdir(exist_ok=True)
    MANIFEST.write_text(json.dumps(manifest), encoding="utf-8")
    print(f"R2から {count} ファイルを取得しました")


def push():
    s3 = client()
    try:
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    except Exception:
        manifest = {}
    sent = 0
    for path in sorted(DATA_DIR.rglob("*")):
        if not path.is_file() or path == MANIFEST:
            continue
        rel = path.relative_to(DATA_DIR).as_posix()
        body = path.read_bytes()
        if manifest.get(rel) == md5(body):
            continue                     # 変わっていないものは送らない
        s3.put_object(
            Bucket=BUCKET,
            Key=PREFIX + rel,
            Body=body,
            ContentType="application/json; charset=utf-8" if rel.endswith(".json") else "application/octet-stream",
        )
        sent += 1
    print(f"R2へ {sent} ファイルを送りました")


if __name__ == "__main__":
    {"pull": pull, "push": push}[sys.argv[1]]()
