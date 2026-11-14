"""GET /sim-tile/{south}/{west}: one 1 x 1 degree fire-spread simulation input tile.

The tiles (fuel + roads + elevation, see pipeline/sim_inputs.py) live in R2 under
sim/. They never change, so responses are marked cacheable for a year: Vercel's
CDN serves repeats without running this function. Tiles with nothing burnable
don't exist (404, also cached).
"""
import duckdb
from fastapi import APIRouter, HTTPException, Path
from fastapi.responses import Response

from _lib import db

router = APIRouter()

CACHE = "public, max-age=31536000, s-maxage=31536000, immutable"


@router.get("/sim-tile/{south}/{west}")
def sim_tile(south: int = Path(ge=-90, le=89), west: int = Path(ge=-180, le=179)):
    cur = db.cursor()
    if not db.r2_enabled:
        raise HTTPException(503, "Simulation inputs are unavailable right now.")
    try:
        row = cur.execute(
            f"SELECT content FROM read_blob('r2://{db.R2_BUCKET}/sim/{south}_{west}.bin')").fetchone()
    except duckdb.HTTPException:
        # Nothing burnable in this tile: the simulation treats it as non-flammable.
        return Response(status_code=404, headers={"Cache-Control": CACHE})
    return Response(content=bytes(row[0]), media_type="application/octet-stream",
                    headers={"Cache-Control": CACHE})
