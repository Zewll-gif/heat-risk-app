# app.py — Heat Risk Web App (FastAPI) — ONNX Runtime LSTM + OpenWeather
import os, json, math, pickle, base64
from pathlib import Path
from datetime import datetime
from zoneinfo import ZoneInfo
from typing import Optional

import numpy as np
import httpx
from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse, JSONResponse
import fastapi.requests
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
from openai import OpenAI

load_dotenv(Path(__file__).parent / ".env", override=True)

BASE          = Path(__file__).parent
TZ_BKK        = ZoneInfo("Asia/Bangkok")

LAT           = float(os.getenv("LAT", 13.7564))
LON           = float(os.getenv("LON", 100.5988))
CITY_NAME     = "กรุงเทพมหานคร"

TYPHOON_KEY   = os.getenv("TYPHOON_API_KEY", "")
TYPHOON_MODEL = "typhoon-v2.5-30b-a3b-instruct"
TYPHOON_BASE  = "https://api.opentyphoon.ai/v1"
OWM_KEY       = os.getenv("OPENWEATHER_API_KEY", "")

FACEPP_KEY    = os.getenv("FACEPP_API_KEY", "")
TMD_KEY        = os.getenv("TMD_API_KEY", "")
WEATHERAPI_KEY = os.getenv("WEATHERAPI_KEY", "")
FACEPP_SECRET = os.getenv("FACEPP_API_SECRET", "")
FACEPP_DETECT = "https://api-us.faceplusplus.com/facepp/v3/detect"

_client = OpenAI(api_key=TYPHOON_KEY, base_url=TYPHOON_BASE)

# ── ONNX Runtime (แทน torch) ──────────────────────────────────────────────────
import onnxruntime as ort

model = None  # onnxruntime InferenceSession
try:
    cfg = json.loads((BASE/"config.json").read_text(encoding="utf-8"))
    FEATURES=cfg["features"]; TS=cfg["time_steps"]; HORIZON=cfg.get("horizon",24)
    P50=cfg["p50"]; P95=cfg["p95"]
    ZONES=cfg.get("zones",[["พระนคร",13.7563,100.4942,4],["สุขุมวิท",13.7310,100.5645,6],["ลาดกระบัง",13.7278,100.7731,2],["มีนบุรี",13.8150,100.7150,3],["บางนา",13.6670,100.5995,5]])
    FORECAST_ZONE=cfg.get("forecast_zone","พระนคร")

    onnx_path = BASE/"model.onnx"
    model = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    INPUT_NAME  = model.get_inputs()[0].name
    OUTPUT_NAME = model.get_outputs()[0].name

    with open(BASE/"scaler.pkl","rb") as f: scaler=pickle.load(f)
    print(f"✅ ONNX Model loaded | Features: {len(FEATURES)} | TS: {TS}")
except Exception as e:
    print(f"⚠️  Model load failed: {e}"); model=scaler=None
    P50=30.0; P95=42.0; HORIZON=24
    FEATURES=["temperature_2m","relative_humidity_2m","wind_speed_10m","sin_hour","cos_hour","sin_doy","cos_doy","elevation_norm","zone_id"]
    TS=168
    ZONES=[["พระนคร",13.7563,100.4942,4],["สุขุมวิท",13.7310,100.5645,6],["ลาดกระบัง",13.7278,100.7731,2],["มีนบุรี",13.8150,100.7150,3],["บางนา",13.6670,100.5995,5]]
    FORECAST_ZONE="พระนคร"

try:
    geojson_data=json.loads((BASE/"grid.geojson").read_text(encoding="utf-8"))
    print(f"✅ GeoJSON: {len(geojson_data['features'])} features")
except: geojson_data={"type":"FeatureCollection","features":[]}

RAG_DOCS=[]
rag_path=BASE/"rag_docs"/"knowledge_base.md"
if rag_path.exists():
    text=rag_path.read_text(encoding="utf-8"); RAG_DOCS=[s.strip() for s in text.split("##") if s.strip()]

def retrieve(query, top_k=4):
    if not RAG_DOCS: return ""
    q=set(query.lower().split())
    scored=sorted([(len(q&set(d.lower().split())),d) for d in RAG_DOCS],reverse=True)
    return "\n\n---\n\n".join(d for s,d in scored[:top_k] if s>0)

def typhoon_text(prompt):
    r=_client.chat.completions.create(model=TYPHOON_MODEL,messages=[{"role":"user","content":prompt}],max_tokens=2048,temperature=0.7)
    return r.choices[0].message.content

async def facepp_estimate_age(img_bytes):
    async with httpx.AsyncClient(timeout=15) as client:
        r=await client.post(FACEPP_DETECT,data={"api_key":FACEPP_KEY,"api_secret":FACEPP_SECRET,"return_attributes":"age,gender"},files={"image_file":("photo.jpg",img_bytes,"image/jpeg")})
        data=r.json()
    faces=data.get("faces",[])
    if not faces: return {"success":False,"error":"ไม่พบใบหน้าในภาพ"}
    attr=faces[0]["attributes"]
    return {"success":True,"age":attr["age"]["value"],"gender":"ชาย" if attr["gender"]["value"]=="Male" else "หญิง"}

def calc_heat_index(T,RH):
    return(-8.784695+1.61139411*T+2.338549*RH-0.14611605*T*RH-0.012308094*T**2
           -0.016424828*RH**2+0.002211732*T**2*RH+0.00072546*T*RH**2-0.000003582*T**2*RH**2)

WHO_HI_LEVELS=[(54,"อันตรายมาก","Extreme Danger"),(41,"อันตราย","Danger"),
               (32,"ระวังมาก","Extreme Caution"),(27,"ระวัง","Caution"),(0,"ปลอดภัย","Safe")]

def hazard_from_hi(daily_max):
    score=float(np.clip((daily_max-27.0)/(54.0-27.0),0,1))
    for threshold,label,note in WHO_HI_LEVELS:
        if daily_max>=threshold:
            return {"score":round(score,4),"label":label,"who_note":note,"daily_max":round(daily_max,2)}
    return {"score":0.0,"label":"ปลอดภัย","who_note":"Safe","daily_max":round(daily_max,2)}

async def fetch_openmeteo():
    async with httpx.AsyncClient(timeout=10) as client:
        r=await client.get("https://api.open-meteo.com/v1/forecast",params={
            "latitude":LAT,"longitude":LON,
            "current":"temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code",
            "hourly":"temperature_2m,relative_humidity_2m,wind_speed_10m",
            "forecast_days":2,"past_days":1,"timezone":"Asia/Bangkok"})
        d=r.json()
    cur=d["current"]; T=cur["temperature_2m"]; RH=cur["relative_humidity_2m"]; WS=cur["wind_speed_10m"]
    api_t=cur.get("time",""); times=d["hourly"].get("time",[])
    try: now_idx=next(i for i,t in enumerate(times) if t==api_t)
    except: now_idx=max(0,len(times)//2)
    ps=max(0,now_idx-24); fe=min(len(times),now_idx+25)
    at=d["hourly"]["temperature_2m"]; ar=d["hourly"]["relative_humidity_2m"]; aw=d["hourly"]["wind_speed_10m"]
    nb=datetime.now(TZ_BKK)
    return {"source":"Open-Meteo","temperature":T,"humidity":RH,"wind_speed":WS,
            "heat_index":round(calc_heat_index(T,RH),2),"weather_code":cur.get("weather_code",0),
            "api_time":api_t,"updated_at":nb.strftime("%H:%M"),"updated_date":nb.strftime("%d/%m/%Y"),
            "hourly_temp":at[max(0,now_idx-TS):now_idx+1],"hourly_rh":ar[max(0,now_idx-TS):now_idx+1],
            "hourly_ws":aw[max(0,now_idx-TS):now_idx+1],"hourly_time":times[max(0,now_idx-TS):now_idx+1],
            "past_temp":at[ps:now_idx+1],"past_time":times[ps:now_idx+1],
            "future_temp":at[now_idx:fe],"future_time":times[now_idx:fe],
            "now_idx_in_past":now_idx-ps}

async def fetch_openweather():
    if not OWM_KEY: raise ValueError("OPENWEATHER_API_KEY ไม่ได้ตั้งค่าใน .env")
    async with httpx.AsyncClient(timeout=10) as client:
        rc=await client.get("https://api.openweathermap.org/data/2.5/weather",
            params={"lat":LAT,"lon":LON,"appid":OWM_KEY,"units":"metric","lang":"th"})
        rf=await client.get("https://api.openweathermap.org/data/2.5/forecast",
            params={"lat":LAT,"lon":LON,"appid":OWM_KEY,"units":"metric","lang":"th","cnt":16})
    cur=rc.json(); fct=rf.json()
    T=cur["main"]["temp"]; RH=cur["main"]["humidity"]; WS=round(cur["wind"]["speed"]*3.6,1)
    nb=datetime.now(TZ_BKK)
    fct_times=[x["dt_txt"].replace(" ","T") for x in fct["list"]]
    fct_temp=[x["main"]["temp"] for x in fct["list"]]
    fct_rh=[x["main"]["humidity"] for x in fct["list"]]
    fct_ws=[round(x["wind"]["speed"]*3.6,1) for x in fct["list"]]
    hourly_temp=[T]; hourly_rh=[RH]; hourly_ws=[WS]
    hourly_time=[nb.strftime("%Y-%m-%dT%H:00")]
    for i in range(min(len(fct_temp),8)):
        prev_t=hourly_temp[-1]; next_t=fct_temp[i]
        prev_r=hourly_rh[-1];  next_r=fct_rh[i]
        prev_w=hourly_ws[-1];  next_w=fct_ws[i]
        for step in range(1,4):
            frac=step/3
            hourly_temp.append(round(prev_t+(next_t-prev_t)*frac,1))
            hourly_rh.append(round(prev_r+(next_r-prev_r)*frac,1))
            hourly_ws.append(round(prev_w+(next_w-prev_w)*frac,1))
            ts_offset=i*3+step
            hourly_time.append((nb.replace(hour=(nb.hour+ts_offset)%24)).strftime("%Y-%m-%dT%H:00"))
    while len(hourly_temp)<TS:
        hourly_temp.insert(0,hourly_temp[0]); hourly_rh.insert(0,hourly_rh[0])
        hourly_ws.insert(0,hourly_ws[0]);     hourly_time.insert(0,hourly_time[0])
    now_t=nb.strftime("%Y-%m-%dT%H:00")
    past_t=[T]; past_time=[now_t]
    future_t=[T]+fct_temp[:8]; future_time=[now_t]+fct_times[:8]
    return {"source":"OpenWeather","temperature":T,"humidity":RH,"wind_speed":WS,
            "heat_index":round(calc_heat_index(T,RH),2),
            "weather_code":cur.get("weather",[])[0].get("id",0) if cur.get("weather") else 0,
            "api_time":now_t,"updated_at":nb.strftime("%H:%M"),"updated_date":nb.strftime("%d/%m/%Y"),
            "hourly_temp":hourly_temp[-TS:],"hourly_rh":hourly_rh[-TS:],
            "hourly_ws":hourly_ws[-TS:],"hourly_time":hourly_time[-TS:],
            "past_temp":past_t,"past_time":past_time,
            "future_temp":future_t,"future_time":future_time,"now_idx_in_past":0,
            "owm_desc":cur.get("weather",[])[0].get("description","") if cur.get("weather") else ""}

async def fetch_weather_now(source="openmeteo"):
    return await fetch_openweather() if source=="openweather" else await fetch_openmeteo()

def predict_24h(hourly_t, hourly_rh, hourly_ws, hourly_time=None):
    if model is None or scaler is None:
        vals=[calc_heat_index(t,rh) for t,rh in zip(hourly_t[:24],hourly_rh[:24])]
        return {**hazard_from_hi(max(vals)),"forecast_24h":[round(v,2) for v in vals]}
    nb=datetime.now(TZ_BKK); doy=nb.timetuple().tm_yday
    zn=[z[0] for z in ZONES]; fi=zn.index(FORECAST_ZONE) if FORECAST_ZONE in zn else 0
    em=max(z[3] for z in ZONES); en=ZONES[fi][3]/em; zin=fi/max(len(ZONES)-1,1)
    rows=[]; n=len(hourly_t)
    for i,(t,rh,ws) in enumerate(zip(hourly_t[-TS:],hourly_rh[-TS:],hourly_ws[-TS:])):
        if hourly_time:
            idx=max(0,n-TS)+i
            try: h=int(hourly_time[idx][11:13]) if idx<len(hourly_time) else (nb.hour-(n-1-i))%24
            except: h=(nb.hour-(n-1-i))%24
        else: h=(nb.hour-(n-1-i))%24
        rows.append([t,rh,ws,math.sin(2*math.pi*h/24),math.cos(2*math.pi*h/24),
                     math.sin(2*math.pi*doy/365),math.cos(2*math.pi*doy/365),en,zin])
    while len(rows)<TS: rows.insert(0,rows[0])
    rows=rows[-TS:]
    X=scaler.transform(np.array(rows, dtype=float))
    # ── ONNX inference ──
    Xt = X[np.newaxis].astype(np.float32)          # (1, TS, features)
    pred24 = model.run([OUTPUT_NAME], {INPUT_NAME: Xt})[0][0].tolist()
    pred24=[round(float(v),2) for v in pred24]
    return {**hazard_from_hi(max(pred24)),"forecast_24h":pred24}

def compute_risk_for_tambon(hs):
    out=[]
    for feat in geojson_data.get("features",[]):
        p=feat.get("properties",{}); vs=p.get("vuln_score",0.5); risk=round(hs*vs,4)
        out.append({"tambon":p.get("tambon_clean",""),"risk":risk,
                    "level":"สูงมาก" if risk>=0.6 else "สูง" if risk>=0.4 else "ปานกลาง" if risk>=0.2 else "ต่ำ",
                    "elderly_pop":p.get("elderly_pop",0),"total_pop":p.get("total_pop",0),"vuln_score":round(vs,4)})
    return sorted(out,key=lambda x:-x["risk"])

app=FastAPI(title="HeatGuard BKK")
app.add_middleware(CORSMiddleware,allow_origins=["*"],allow_methods=["*"],allow_headers=["*"])
app.mount("/static",StaticFiles(directory=BASE/"static"),name="static")
templates=Jinja2Templates(directory=str(BASE/"templates"))

@app.get("/",response_class=HTMLResponse)
async def index(request:fastapi.requests.Request):
    return templates.TemplateResponse("index.html",{"request":request})

@app.get("/api/weather")
async def api_weather(source:str="openmeteo"):
    try: return await fetch_weather_now(source)
    except Exception as e: raise HTTPException(500,str(e))

@app.get("/api/forecast")
async def api_forecast(source:str="openmeteo"):
    try:
        from datetime import timedelta

        nb=datetime.now(TZ_BKK)
        now_iso=nb.strftime("%Y-%m-%dT%H:00")
        base_dt=nb.replace(minute=0,second=0,microsecond=0)

        om=await fetch_openmeteo()
        res=predict_24h(om["hourly_temp"],om["hourly_rh"],om["hourly_ws"],om["hourly_time"])

        om_times_full=[]
        for h in range(-24,25):
            om_times_full.append((base_dt+timedelta(hours=h)).strftime("%Y-%m-%dT%H:00"))

        async with httpx.AsyncClient(timeout=12) as client:
            raw=await client.get("https://api.open-meteo.com/v1/forecast",params={
                "latitude":LAT,"longitude":LON,
                "hourly":"temperature_2m,relative_humidity_2m",
                "forecast_days":2,"past_days":2,"timezone":"Asia/Bangkok"})
        rd=raw.json()
        raw_times=rd["hourly"].get("time",[])
        raw_temp=rd["hourly"].get("temperature_2m",[])
        raw_rh=rd["hourly"].get("relative_humidity_2m",[])
        om_t_map={t:v for t,v in zip(raw_times,raw_temp)}
        om_rh_map={t:v for t,v in zip(raw_times,raw_rh)}

        chart_times=om_times_full
        chart_hi_om=[]
        chart_temp_om=[]
        for ts in chart_times:
            tv=om_t_map.get(ts); rv=om_rh_map.get(ts)
            if tv is not None and rv is not None:
                chart_hi_om.append(round(calc_heat_index(float(tv),float(rv)),2))
                chart_temp_om.append(round(float(tv),2))
            else:
                chart_hi_om.append(None)
                chart_temp_om.append(None)

        now_idx=24

        chart_hi_owm=[None]*len(chart_times)

        def owm_ts(dt_txt: str) -> str:
            return dt_txt[:13].replace(" ","T") + ":00"

        if OWM_KEY:
            try:
                async with httpx.AsyncClient(timeout=10) as client:
                    rc=await client.get("https://api.openweathermap.org/data/2.5/weather",
                        params={"lat":LAT,"lon":LON,"appid":OWM_KEY,"units":"metric"})
                    rf=await client.get("https://api.openweathermap.org/data/2.5/forecast",
                        params={"lat":LAT,"lon":LON,"appid":OWM_KEY,"units":"metric","cnt":16})
                cur_o=rc.json(); fct_o=rf.json()
                owm_now_t=float(cur_o["main"]["temp"])
                owm_now_r=float(cur_o["main"]["humidity"])
                om_now_t=om_t_map.get(now_iso, owm_now_t)
                om_now_r=om_rh_map.get(now_iso, owm_now_r)
                t_ratio=(owm_now_t/om_now_t) if om_now_t else 1.0
                r_ratio=(owm_now_r/om_now_r) if om_now_r else 1.0
                for i,ts in enumerate(chart_times):
                    if ts <= now_iso:
                        tv=om_t_map.get(ts); rv=om_rh_map.get(ts)
                        if tv is not None and rv is not None:
                            dist=max(0, now_idx-i)
                            blend=max(0.0, 1.0-dist/24.0)
                            adj_t=float(tv)*(1+blend*(t_ratio-1))
                            adj_r=float(rv)*(1+blend*(r_ratio-1))
                            chart_hi_owm[i]=round(calc_heat_index(adj_t,adj_r),2)
                owm_fct_map={}
                owm_fct_map[now_iso]=(owm_now_t, owm_now_r)
                flist=fct_o.get("list",[])
                prev_ts=now_iso; prev_t=owm_now_t; prev_r=owm_now_r
                for fx in flist:
                    fx_ts=owm_ts(fx["dt_txt"])
                    fx_t=float(fx["main"]["temp"]); fx_r=float(fx["main"]["humidity"])
                    try:
                        t0=datetime.strptime(prev_ts,"%Y-%m-%dT%H:00")
                        t1=datetime.strptime(fx_ts,  "%Y-%m-%dT%H:00")
                        steps=max(1, int((t1-t0).total_seconds()/3600))
                    except: steps=3
                    for s in range(1, steps+1):
                        frac=s/steps
                        it=round(prev_t+(fx_t-prev_t)*frac,2)
                        ir=round(prev_r+(fx_r-prev_r)*frac,1)
                        isokey=(datetime.strptime(prev_ts,"%Y-%m-%dT%H:00")
                                +timedelta(hours=s)).strftime("%Y-%m-%dT%H:00")
                        owm_fct_map[isokey]=(it, ir)
                    prev_ts=fx_ts; prev_t=fx_t; prev_r=fx_r
                for i,ts in enumerate(chart_times):
                    if ts > now_iso and ts in owm_fct_map:
                        tv2,rv2=owm_fct_map[ts]
                        chart_hi_owm[i]=round(calc_heat_index(tv2,rv2),2)
            except Exception as oe:
                import traceback; traceback.print_exc()
                print(f"OWM fetch error: {oe}")

        async with httpx.AsyncClient(timeout=12) as client:
            ext=await client.get("https://api.open-meteo.com/v1/forecast",params={
                "latitude":LAT,"longitude":LON,
                "hourly":"temperature_2m,relative_humidity_2m,wind_speed_10m",
                "forecast_days":3,"past_days":9,"timezone":"Asia/Bangkok"})
        ed=ext.json()
        ext_times=ed["hourly"].get("time",[])
        ext_temp =ed["hourly"].get("temperature_2m",[])
        ext_rh   =ed["hourly"].get("relative_humidity_2m",[])
        ext_ws   =ed["hourly"].get("wind_speed_10m",[])
        ext_t_map ={t:v for t,v in zip(ext_times,ext_temp)}
        ext_r_map ={t:v for t,v in zip(ext_times,ext_rh)}
        ext_w_map ={t:v for t,v in zip(ext_times,ext_ws)}

        chart_hi_model=[None]*len(chart_times)
        if model is not None and scaler is not None:
            zn=[z[0] for z in ZONES]; fi=zn.index(FORECAST_ZONE) if FORECAST_ZONE in zn else 0
            em=max(z[3] for z in ZONES); en_z=ZONES[fi][3]/em; zin=fi/max(len(ZONES)-1,1)
            fallback_row=[30.0,70.0,5.0,0.0,1.0,0.0,1.0,en_z,zin]

            batch_X=[]
            valid_idx=[]
            for ci,ts in enumerate(chart_times):
                ts_dt=datetime.strptime(ts,"%Y-%m-%dT%H:00")
                win_rows=[]
                for back in range(TS-1,-1,-1):
                    wt=(ts_dt-timedelta(hours=back)).strftime("%Y-%m-%dT%H:00")
                    t_v=ext_t_map.get(wt); r_v=ext_r_map.get(wt); w_v=ext_w_map.get(wt,5.0)
                    if t_v is None or r_v is None:
                        win_rows.append(list(fallback_row))
                        continue
                    wt_dt=ts_dt-timedelta(hours=back)
                    h_w=wt_dt.hour; d_w=wt_dt.timetuple().tm_yday
                    win_rows.append([float(t_v),float(r_v),float(w_v),
                        math.sin(2*math.pi*h_w/24),math.cos(2*math.pi*h_w/24),
                        math.sin(2*math.pi*d_w/365),math.cos(2*math.pi*d_w/365),en_z,zin])
                while len(win_rows)<TS: win_rows.insert(0,list(fallback_row))
                batch_X.append(win_rows[-TS:])
                valid_idx.append(ci)

            try:
                arr=np.array(batch_X, dtype=float)
                N=arr.shape[0]
                flat=arr.reshape(-1, arr.shape[-1])
                flat_s=scaler.transform(flat)
                arr_s=flat_s.reshape(N, TS, -1).astype(np.float32)
                # ── ONNX batch inference ──
                preds = model.run([OUTPUT_NAME], {INPUT_NAME: arr_s})[0]  # (N, horizon)
                for k,ci in enumerate(valid_idx):
                    chart_hi_model[ci]=round(float(preds[k][0]),2)
            except Exception as me:
                print(f"ONNX batch predict error: {me}")
        else:
            for ci,ts in enumerate(chart_times):
                tv=ext_t_map.get(ts); rv=ext_r_map.get(ts)
                if tv is not None and rv is not None:
                    chart_hi_model[ci]=round(calc_heat_index(float(tv),float(rv)),2)

        return {
            **res,
            "weather":om,
            "now_time":now_iso,
            "now_idx":now_idx,
            "chart_times":chart_times,
            "chart_temp_om":chart_temp_om,
            "chart_hi_om":chart_hi_om,
            "chart_hi_owm":chart_hi_owm,
            "chart_hi_model":chart_hi_model,
            "owm_available":bool(OWM_KEY),
            "source":"Open-Meteo + OpenWeather",
            "updated_at":om["updated_at"],
            "updated_date":om["updated_date"],
        }
    except Exception as e:
        import traceback; traceback.print_exc(); raise HTTPException(500,str(e))

@app.get("/api/geojson")
async def api_geojson(source:str="openmeteo"):
    try:
        w=await fetch_weather_now(source); res=predict_24h(w["hourly_temp"],w["hourly_rh"],w["hourly_ws"],w["hourly_time"])
        hs=res["score"]; out={"type":"FeatureCollection","features":[]}
        for feat in geojson_data.get("features",[]):
            f2=dict(feat); props=dict(feat.get("properties",{})); vs=props.get("vuln_score",0.5); risk=round(hs*vs,4)
            props["combined_risk"]=risk; props["hazard_score"]=round(hs,4); props["heat_index_pred"]=res["daily_max"]
            props["risk_level"]="สูงมาก" if risk>=0.6 else "สูง" if risk>=0.4 else "ปานกลาง" if risk>=0.2 else "ต่ำ"
            f2["properties"]=props; out["features"].append(f2)
        return JSONResponse(out)
    except Exception as e: raise HTTPException(500,str(e))

class SimRequest(BaseModel):
    temperature:float; humidity:float; wind_speed:float=5.0

@app.post("/api/simulate")
async def api_simulate(req:SimRequest):
    hi=calc_heat_index(req.temperature,req.humidity); hz=hazard_from_hi(hi)
    return {"heat_index":round(hi,2),"hazard":hz,"tambon_risk":compute_risk_for_tambon(hz["score"]),"simulated":True}

@app.post("/api/estimate-age")
async def api_estimate_age(file:UploadFile=File(...)):
    try: return await facepp_estimate_age(await file.read())
    except Exception as e: return {"success":False,"error":str(e)}

class AgeBase64Request(BaseModel): image_base64:str

@app.post("/api/estimate-age-b64")
async def api_estimate_age_b64(req:AgeBase64Request):
    try: return await facepp_estimate_age(base64.b64decode(req.image_base64))
    except Exception as e: return {"success":False,"error":str(e)}

class PersonalRisk(BaseModel):
    age:int; tambon:str; has_disease:bool=False; source:str="openmeteo"

@app.post("/api/personal-risk")
async def api_personal_risk(req:PersonalRisk):
    try:
        w=await fetch_weather_now(req.source)
        res=predict_24h(w["hourly_temp"],w["hourly_rh"],w["hourly_ws"],w["hourly_time"]); hs=res["score"]
        if req.age>=65: af=0.90; wg="ผู้สูงอายุ (≥65 ปี)"
        elif req.age>=60: af=0.80; wg="ผู้สูงอายุ (60–64 ปี)"
        elif req.age<5: af=0.85; wg="เด็กเล็ก (<5 ปี)"
        elif req.age<18: af=0.50; wg="เด็ก/วัยรุ่น (5–17 ปี)"
        elif req.age<40: af=0.40; wg="วัยผู้ใหญ่ตอนต้น (18–39 ปี)"
        else: af=0.55; wg="วัยกลางคน (40–64 ปี)"
        dn=""
        if req.has_disease: af=min(af+0.25,1.0); dn="มีโรคประจำตัว — เพิ่มความเสี่ยง 2–3 เท่า"
        tvs=0.5; ti=""
        for feat in geojson_data.get("features",[]):
            p=feat.get("properties",{})
            if p.get("tambon_clean","").strip()==req.tambon.strip():
                tvs=p.get("vuln_score",0.5)
                ti=f"เขต{req.tambon}: Vulnerability {tvs:.3f} | ผู้สูงอายุ 60+ {p.get('elderly_pop',0):,} คน | ประชากรรวม {p.get('total_pop',0):,} คน"
                break
        ps=round(hs*0.40+af*0.35+tvs*0.25,4); ps=max(ps,0.05)
        if ps>=0.80: lv="วิกฤต"
        elif ps>=0.60: lv="สูงมาก"
        elif ps>=0.40: lv="สูง"
        elif ps>=0.20: lv="ปานกลาง"
        else: lv="ต่ำ"
        ctx=retrieve(f"heat stroke อายุ {req.age} ปี {lv} เขต {req.tambon} กรุงเทพ")
        prompt=f"""คุณเป็นระบบวิเคราะห์ความเสี่ยง Heat Stroke สำหรับพื้นที่กรุงเทพมหานคร

=== สภาพอากาศปัจจุบัน (แหล่ง: {w.get('source','')}) ===
อุณหภูมิ {w['temperature']}°C | ความชื้น {w['humidity']}% | ลม {w['wind_speed']} km/h
Heat Index ปัจจุบัน: {w['heat_index']}°C | สูงสุด 24h: {res['daily_max']}°C
Hazard Score: {hs:.3f} — {res['label']}
พื้นที่: กรุงเทพมหานคร (Urban Heat Island — อุณหภูมิสูงกว่าชานเมือง 3–5°C)

=== ข้อมูลบุคคล ===
อายุ {req.age} ปี ({wg}) | {dn if dn else 'ไม่มีโรคประจำตัว'}
{ti}
คะแนนความเสี่ยงส่วนตัว: {ps:.3f} — ระดับ{lv}
  (สภาพอากาศ {hs:.3f}×0.40) + (อายุ {af:.2f}×0.35) + (พื้นที่ {tvs:.3f}×0.25)

=== ฐานความรู้ ===
{ctx if ctx else '-'}

ตอบ 3 ส่วน (ภาษาไทย กระชับ อ้างตัวเลขจริงเท่านั้น ห้ามสมมติ):
1) วิเคราะห์ความเสี่ยงของบุคคลอายุ {req.age} ปี ในเขต{req.tambon} กรุงเทพมหานคร
2) คำแนะนำเฉพาะสำหรับช่วงเวลานี้ในกรุงเทพฯ (3–4 ข้อ เป็นรูปธรรม รวมถึงการใช้ระบบขนส่งสาธารณะ BTS/MRT)
3) อาการที่ต้องพบแพทย์ทันที โทร 1669"""
        exp=typhoon_text(prompt)
        return {"personal_score":ps,"level":lv,"age_factor":round(af,2),"tambon_vuln":round(tvs,2),
                "hazard_score":round(hs,3),"heat_index":w["heat_index"],"daily_max":res["daily_max"],
                "explanation":exp,"score_breakdown":{"hazard":round(hs*0.40,4),"age":round(af*0.35,4),"tambon":round(tvs*0.25,4)}}
    except Exception as e:
        import traceback; traceback.print_exc(); raise HTTPException(500,str(e))

class ChatRequest(BaseModel):
    message:str; context_tambon:Optional[str]=None; source:str="openmeteo"

@app.post("/api/chat")
async def api_chat(req:ChatRequest):
    try:
        ctx=retrieve(req.message); w=await fetch_weather_now(req.source); hz=hazard_from_hi(w["heat_index"])
        prompt=f"""คุณเป็นผู้เชี่ยวชาญด้านความเสี่ยง Heat Stroke พื้นที่กรุงเทพมหานคร แต่ถ้าผู้ใช้ชวนคุยเล่นหรือนอกเรื่องคุณก็สามารถตอบเล่นได้ ไม่จำเป็นต้องดึงเข้าประเด็นสภาพอากาศตลอดเวลา
ระบบใช้ ONNX LSTM ฝึกจากข้อมูลอุณหภูมิกรุงเทพฯ
กรุงเทพมหานครมีปรากฏการณ์ Urban Heat Island ทำให้อุณหภูมิในเมืองสูงกว่าปกติ 3–5°C

=== ข้อมูลปัจจุบัน (แหล่ง: {w.get('source','')}) ===
อุณหภูมิ {w['temperature']}°C | ความชื้น {w['humidity']}% | ลม {w['wind_speed']} km/h
Heat Index: {w['heat_index']}°C — {hz['label']} (Score: {hz['score']:.3f})
เวลา: {w['updated_at']} น. | พิกัด: กรุงเทพมหานคร ({LAT}, {LON})
{f"เขตที่สนใจ: {req.context_tambon}" if req.context_tambon else ""}

=== ฐานความรู้ ===
{ctx if ctx else '-'}

คำถาม: {req.message}
ตอบภาษาไทย กระชับ อ้างตัวเลขจริง ให้ข้อมูลที่เกี่ยวข้องกับสภาพแวดล้อมกรุงเทพฯ แต่ถ้าผู้ใช้ชวนคุยเล่นหรือนอกเรื่องคุณก็สามารถตอบเล่นได้ ไม่จำเป็นต้องดึงเข้าประเด็นสภาพอากาศตลอดเวลา"""
        return {"reply":typhoon_text(prompt)}
    except Exception as e: raise HTTPException(500,str(e))

@app.get("/api/weather-sources")
async def api_weather_sources():
    return {"openmeteo":True,"openweather":bool(OWM_KEY),"tmd":bool(TMD_KEY),"weatherapi":bool(WEATHERAPI_KEY)}

if __name__=="__main__":
    import uvicorn; uvicorn.run("app:app",host="0.0.0.0",port=8000,reload=True)