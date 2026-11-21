"""
Jaiylym — сбор реальных спутниковых данных по пастбищам одного села.

Что делает:
  1. Делит окрестности села на участки: 8 направлений x 2 кольца
     (ближние «околоаульные» 0.5–3 км и дальние 3–8 км).
  2. Берёт карту ESA WorldCover (10 м) и считает в каждом участке только
     пиксели «трава / кустарник / редкая растительность» — это и есть пастбище.
     Пашня, дома, вода, лес не считаются.
  3. Берёт снимки Sentinel-2 за пик сезона (июнь–август) двух лет
     (базовый год и текущий), убирает облака и считает средний NDVI.
  4. Сохраняет web/data/plots.json и картинку-слой NDVI для карты.

Источник данных: Microsoft Planetary Computer (бесплатно, без ключа).

Запуск:
  python ndvi.py --name "Кеген" --lat 43.020 --lon 79.220
"""
import argparse
import json
import math
import os

import numpy as np
import planetary_computer
import pystac_client
import rasterio
from rasterio.enums import Resampling
from rasterio.features import geometry_mask
from rasterio.warp import transform_geom, transform_bounds, reproject
from rasterio.windows import from_bounds
from rasterio.transform import from_bounds as transform_from_bounds

STAC = "https://planetarycomputer.microsoft.com/api/stac/v1"
RES = 20  # метров на пиксель при расчёте (достаточно для участков в сотни га)

# ESA WorldCover классы
WC_PASTURE = {20, 30, 60}   # кустарник, трава, редкая растительность
WC_WATER = {80}

# Sentinel-2 SCL: оставляем растительность, голую почву
SCL_OK = {4, 5}

DIRS = ["С", "СВ", "В", "ЮВ", "Ю", "ЮЗ", "З", "СЗ"]
RINGS = [(0.5, 3.0, "Б"), (3.0, 8.0, "Д")]  # Б = ближний, Д = дальний


def sector(lat, lon, r1_km, r2_km, a1_deg, a2_deg, steps=12):
    """Полигон сектора кольца в WGS84 (азимут от севера по часовой)."""
    kx = 111.32 * math.cos(math.radians(lat))
    ky = 110.57
    pts = []
    for i in range(steps + 1):
        a = math.radians(a1_deg + (a2_deg - a1_deg) * i / steps)
        pts.append((lon + r2_km * math.sin(a) / kx, lat + r2_km * math.cos(a) / ky))
    for i in range(steps, -1, -1):
        a = math.radians(a1_deg + (a2_deg - a1_deg) * i / steps)
        pts.append((lon + r1_km * math.sin(a) / kx, lat + r1_km * math.cos(a) / ky))
    pts.append(pts[0])
    return {"type": "Polygon", "coordinates": [pts]}


def make_plots(lat, lon):
    plots = []
    for r1, r2, ring in RINGS:
        for i, d in enumerate(DIRS):
            a1, a2 = i * 45 - 22.5, i * 45 + 22.5
            plots.append({
                "id": f"{ring}-{d}",
                "ring": "near" if ring == "Б" else "far",
                "dir": d,
                "dist_km": round((r1 + r2) / 2, 1),
                "geometry": sector(lat, lon, r1, r2, a1, a2),
            })
    return plots


def read_band(href, bounds_wgs, out_crs=None, grid=None):
    """Читает кусок COG в заданную сетку (crs, transform, shape)."""
    with rasterio.open(href) as src:
        crs, transform, shape = grid
        dst = np.zeros(shape, dtype="float32")
        reproject(
            source=rasterio.band(src, 1),
            destination=dst,
            src_crs=src.crs,
            dst_crs=crs,
            dst_transform=transform,
            resampling=Resampling.nearest if "SCL" in href or "map" in href.lower() else Resampling.bilinear,
            dst_nodata=0,
        )
        return dst


def search(client, collection, bbox, dt, query=None, limit=50):
    s = client.search(collections=[collection], bbox=bbox, datetime=dt, query=query, max_items=limit)
    return list(s.items())


def ndvi_median(client, bbox, year, grid, max_scenes=6):
    items = search(client, "sentinel-2-l2a", bbox, f"{year}-06-01/{year}-08-31",
                   query={"eo:cloud_cover": {"lt": 20}})
    items.sort(key=lambda it: it.properties["eo:cloud_cover"])
    items = items[:max_scenes]
    if not items:
        raise SystemExit(f"Нет безоблачных снимков за {year}")
    stack = []
    dates = []
    for it in items:
        it = planetary_computer.sign(it)
        red = read_band(it.assets["B04"].href, bbox, grid=grid)
        nir = read_band(it.assets["B08"].href, bbox, grid=grid)
        scl = read_band(it.assets["SCL"].href, bbox, grid=grid)
        good = np.isin(scl, list(SCL_OK)) & (red + nir > 0)
        # С processing baseline 04.00 (2022+) ESA добавляет к отражению +1000 — убираем
        if it.properties.get("s2:processing_baseline", "00.00") >= "04.00":
            red, nir = red - 1000, nir - 1000
            good &= (red > 0) & (nir > 0)
        nd = np.where(good, (nir - red) / np.maximum(nir + red, 1), np.nan)
        stack.append(nd)
        dates.append(it.datetime.date().isoformat())
        print(f"  {year}: снимок {dates[-1]}, облачность {it.properties['eo:cloud_cover']:.1f}%")
    with np.errstate(all="ignore"):
        med = np.nanmedian(np.stack(stack), axis=0)
    return med, dates


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="Кеген")
    ap.add_argument("--lat", type=float, default=43.020)
    ap.add_argument("--lon", type=float, default=79.220)
    ap.add_argument("--base-year", type=int, default=2019)
    ap.add_argument("--year", type=int, default=2025)
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "web", "data"))
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    lat, lon = args.lat, args.lon
    dlat = 8.6 / 110.57
    dlon = 8.6 / (111.32 * math.cos(math.radians(lat)))
    bbox = [lon - dlon, lat - dlat, lon + dlon, lat + dlat]

    client = pystac_client.Client.open(STAC, modifier=planetary_computer.sign_inplace)

    # Общая сетка расчёта: UTM зона по долготе, 20 м
    zone = int((lon + 180) // 6) + 1
    crs = f"EPSG:{32600 + zone if lat >= 0 else 32700 + zone}"
    l, b, r, t = transform_bounds("EPSG:4326", crs, *bbox)
    w, h = int((r - l) / RES), int((t - b) / RES)
    transform = transform_from_bounds(l, b, r, t, w, h)
    grid = (crs, transform, (h, w))
    print(f"Сетка {w}x{h} пикселей по {RES} м, {crs}")

    # 1. Покрытие земли
    print("ESA WorldCover…")
    wc_items = search(client, "esa-worldcover", bbox, None)
    wc_items.sort(key=lambda it: it.properties.get("esa_worldcover:product_version", ""), reverse=True)
    wc = np.zeros((h, w), dtype="float32")
    for it in wc_items:
        part = read_band(it.assets["map"].href, bbox, grid=grid)
        wc = np.where(wc == 0, part, wc)
    pasture_px = np.isin(wc, list(WC_PASTURE))
    water_px = np.isin(wc, list(WC_WATER))

    # 2. NDVI двух лет
    print("Sentinel-2…")
    nd_base, dates_base = ndvi_median(client, bbox, args.base_year, grid)
    nd_now, dates_now = ndvi_median(client, bbox, args.year, grid)

    # 3. Статистика по участкам
    plots = make_plots(lat, lon)
    px_ha = RES * RES / 10000
    for p in plots:
        geom_utm = transform_geom("EPSG:4326", crs, p["geometry"])
        inside = geometry_mask([geom_utm], out_shape=(h, w), transform=transform, invert=True)
        past = inside & pasture_px
        p["area_ha"] = round(float(inside.sum() * px_ha))
        p["pasture_ha"] = round(float(past.sum() * px_ha))
        p["water_px"] = int((inside & water_px).sum())
        with np.errstate(all="ignore"):
            nb = float(np.nanmean(np.where(past, nd_base, np.nan)))
            nn = float(np.nanmean(np.where(past, nd_now, np.nan)))
        p["ndvi_base"] = None if math.isnan(nb) else round(nb, 3)
        p["ndvi"] = None if math.isnan(nn) else round(nn, 3)
        # вода: ближние участки — у села есть вода; дальние — если на карте есть водоём
        p["water"] = p["ring"] == "near" or p["water_px"] * px_ha >= 0.5
        p["water_source"] = "село" if p["ring"] == "near" else ("водоём на карте WorldCover" if p["water"] else "нет")

    # 4. Слой NDVI для карты (в WGS84, PNG с прозрачностью)
    ow, oh = 600, 600
    otr = transform_from_bounds(*bbox, ow, oh)
    nd4326 = np.full((oh, ow), np.nan, dtype="float32")
    reproject(nd_now, nd4326, src_crs=crs, src_transform=transform, dst_crs="EPSG:4326",
              dst_transform=otr, src_nodata=np.nan, dst_nodata=np.nan, resampling=Resampling.bilinear)
    pm4326 = np.zeros((oh, ow), dtype="uint8")
    reproject(pasture_px.astype("uint8"), pm4326, src_crs=crs, src_transform=transform,
              dst_crs="EPSG:4326", dst_transform=otr, resampling=Resampling.nearest)
    rgba = ndvi_rgba(nd4326, pm4326.astype(bool))
    with rasterio.open(os.path.join(args.out, "ndvi.png"), "w", driver="PNG", width=ow, height=oh,
                       count=4, dtype="uint8") as dst:
        dst.write(rgba)

    out = {
        "village": {"name": args.name, "lat": lat, "lon": lon},
        "bbox": bbox,
        "source": {
            "ndvi": "Sentinel-2 L2A (ESA Copernicus), медиана безоблачных снимков июнь–август",
            "landcover": "ESA WorldCover 10 м",
            "base_year": args.base_year, "year": args.year,
            "dates_base": dates_base, "dates": dates_now,
        },
        "plots": plots,
    }
    with open(os.path.join(args.out, "plots.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    # тот же файл как JS, чтобы web/index.html открывался двойным кликом без сервера
    with open(os.path.join(args.out, "plots.js"), "w", encoding="utf-8") as f:
        f.write("window.JAIYLYM_DATA = ")
        json.dump(out, f, ensure_ascii=False)
        f.write(";\n")

    print("\nУчасток   пастбище,га  NDVI " + str(args.base_year) + " → " + str(args.year) + "   вода")
    for p in plots:
        print(f"{p['id']:8} {p['pasture_ha']:8}      {p['ndvi_base']} → {p['ndvi']}    {p['water_source']}")
    print(f"\nГотово: {args.out}/plots.json")


def ndvi_rgba(nd, mask):
    """Цвет: коричневый (мало травы) → жёлтый → зелёный. Не пастбище — прозрачно."""
    stops = [(0.05, (140, 81, 10)), (0.2, (223, 194, 125)), (0.35, (166, 217, 106)), (0.55, (26, 150, 65))]
    v = np.nan_to_num(nd, nan=-1)
    out = np.zeros((4,) + nd.shape, dtype="uint8")
    for c in range(3):
        xs = [s[0] for s in stops]
        ys = [s[1][c] for s in stops]
        out[c] = np.interp(v, xs, ys).astype("uint8")
    out[3] = np.where(mask & ~np.isnan(nd), 190, 0)
    return out


if __name__ == "__main__":
    main()
