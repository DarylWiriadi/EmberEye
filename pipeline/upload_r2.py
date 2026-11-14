"""Upload the staged hotspot points (data/r2/points/, sample/, wide/) to Cloudflare R2.

Credentials come from environment variables, or from pipeline/.env (gitignored):
    R2_ACCOUNT_ID=...
    R2_ACCESS_KEY_ID=...
    R2_SECRET_ACCESS_KEY=...
    R2_BUCKET=embereye-hotspots

Files already in the bucket with the same size are skipped, so it's safe to
stop and re-run. For each staged folder, objects under it in the bucket that
are no longer staged are deleted; folders not staged locally are left alone.

Usage:  python upload_r2.py            # upload
        python upload_r2.py --check    # test the credentials only
"""
import argparse
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import boto3
from botocore.config import Config

import config as C

PREFIXES = ("points/", "sample/", "wide/")


def load_env():
    env = C.ROOT / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    missing = [k for k in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET")
               if not os.environ.get(k)]
    if missing:
        sys.exit(f"Missing {', '.join(missing)} (set them, or put them in {env})")


def client():
    return boto3.client(
        "s3",
        endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
        config=Config(retries={"max_attempts": 8, "mode": "adaptive"}),
    )


def existing(s3, bucket, prefix) -> dict[str, int]:
    out = {}
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            out[obj["Key"]] = obj["Size"]
    return out


def main(args):
    sys.stdout.reconfigure(encoding="utf-8")
    load_env()
    s3, bucket = client(), os.environ["R2_BUCKET"]
    stage = C.R2_STAGE_DIR
    remote, local = {}, {}
    for prefix in PREFIXES:
        r = existing(s3, bucket, prefix)
        print(f"Bucket '{bucket}': {len(r)} files under {prefix}")
        staged = {f.relative_to(stage).as_posix(): f for f in sorted((stage / prefix).rglob("*.parquet"))}
        if staged:
            remote |= r
            local |= staged
    if args.check:
        return
    if not local:
        sys.exit(f"Nothing staged in {stage}; run export_points.py first")
    todo = [(k, f) for k, f in local.items() if remote.get(k) != f.stat().st_size]
    stale = [k for k in remote if k not in local]
    total = sum(f.stat().st_size for _, f in todo)
    print(f"{len(local)} staged, {len(todo)} to upload ({total / 1e9:.2f} GB), {len(stale)} to delete")

    t0, done, sent = time.time(), 0, 0
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(s3.upload_file, str(f), bucket, k,
                               ExtraArgs={"ContentType": "application/vnd.apache.parquet"}): (k, f)
                   for k, f in todo}
        for fut in as_completed(futures):
            k, f = futures[fut]
            fut.result()
            done += 1
            sent += f.stat().st_size
            if done % 50 == 0 or done == len(todo):
                rate = sent / max(time.time() - t0, 1e-9) / 1e6
                print(f"  {done}/{len(todo)} files, {sent / 1e9:.2f} GB, {rate:.1f} MB/s")
    for i in range(0, len(stale), 1000):
        s3.delete_objects(Bucket=bucket, Delete={"Objects": [{"Key": k} for k in stale[i:i + 1000]]})
    print(f"Done in {(time.time() - t0) / 60:.1f} min")


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--check", action="store_true", help="only test the connection")
    main(p.parse_args())
