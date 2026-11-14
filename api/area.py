"""Turn the request's area (bbox or H3 cells) into a temp table `sel(cell5, cell3)`.

Only cells that have ever had a fire are listed in `cells`, so the selection
is "all burnable-in-practice H3 res 5 cells in the area".
"""
import h3
from fastapi import HTTPException

MONTHLY_RES = 5
MAX_INPUT_CELLS = 50_000


def parse_bbox(bbox: str) -> tuple[float, float, float, float]:
    try:
        w, s, e, n = (float(v) for v in bbox.split(","))
    except ValueError:
        raise HTTPException(400, "bbox must be 'west,south,east,north' in degrees")
    if not (-180 <= w <= 180 and -180 <= e <= 180 and -90 <= s < n <= 90):
        raise HTTPException(400, "bbox out of range (lon -180..180, lat -90..90, south < north)")
    return w, s, e, n


def cells_to_res5(cells: str) -> list[int]:
    """H3 cells of any resolution -> res 5 cell ids (parents of finer cells,
    children of coarser ones)."""
    out: set[int] = set()
    items = [c.strip() for c in cells.split(",") if c.strip()]
    if len(items) > MAX_INPUT_CELLS:
        raise HTTPException(400, f"too many cells (max {MAX_INPUT_CELLS})")
    for c in items:
        if not h3.is_valid_cell(c):
            raise HTTPException(400, f"invalid H3 cell: {c}")
        res = h3.get_resolution(c)
        if res >= MONTHLY_RES:
            out.add(h3.str_to_int(h3.cell_to_parent(c, MONTHLY_RES)))
        else:
            out.update(h3.str_to_int(x) for x in h3.cell_to_children(c, MONTHLY_RES))
    return sorted(out)


def select_area(cur, bbox: str | None, cells: str | None) -> int:
    """Create temp table `sel` for this cursor; returns the number of res 5 cells."""
    if bool(bbox) == bool(cells):
        raise HTTPException(400, "give exactly one of 'bbox' or 'cells'")
    if bbox:
        w, s, e, n = parse_bbox(bbox)
        lng = "lng BETWEEN ? AND ?" if w <= e else "(lng >= ? OR lng <= ?)"  # crosses the antimeridian
        cur.execute(f"""CREATE OR REPLACE TEMP TABLE sel AS
                        SELECT cell5, cell3 FROM cells WHERE lat BETWEEN ? AND ? AND {lng}""",
                    [s, n, w, e])
    else:
        ids = cells_to_res5(cells)
        cur.execute("""CREATE OR REPLACE TEMP TABLE sel AS
                       SELECT cell5, cell3 FROM cells
                       WHERE cell5 IN (SELECT unnest(?::UBIGINT[]))""", [ids])
    return cur.execute("SELECT count(*) FROM sel").fetchone()[0]
