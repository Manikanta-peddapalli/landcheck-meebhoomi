require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const puppeteer = require("puppeteer");

const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 3001;
const CAPTCHA_KEY = process.env.CAPTCHA_API_KEY || "";

// ── Solve captcha via 2captcha ─────────────────────────────
async function solveCaptcha(base64img) {
  if (!CAPTCHA_KEY) return null;
  try {
    const sub = await axios.post("http://2captcha.com/in.php", {
      key: CAPTCHA_KEY, method: "base64", body: base64img, json: 1
    });
    const id = sub.data.request;
    await new Promise(r => setTimeout(r, 18000));
    const sol = await axios.get(
      `http://2captcha.com/res.php?key=${CAPTCHA_KEY}&action=get&id=${id}&json=1`
    );
    return sol.data.status === 1 ? sol.data.request : null;
  } catch(e) { return null; }
}

// ── Reverse geocode GPS → village/mandal/district ──────────
async function reverseGeocode(lat, lon) {
  try {
    const res = await axios.get(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1`,
      { headers: { "User-Agent": "LandCheck/1.0 manikanta1742@gmail.com" }, timeout: 8000 }
    );
    const addr = res.data.address || {};
    return {
      village: addr.village || addr.hamlet || addr.suburb || addr.town || addr.city || "",
      mandal: addr.county || addr.state_district || "",
      district: addr.state_district || addr.county || "",
      state: addr.state || "Andhra Pradesh",
      display: res.data.display_name || ""
    };
  } catch(e) {
    return { village:"", mandal:"", district:"", state:"Andhra Pradesh" };
  }
}

// ── Try APSAC GeoServer for survey number from GPS ─────────
async function getSurveyFromAPSAC(lat, lon) {
  try {
    const delta = 0.0005;
    const bbox = `${lon-delta},${lat-delta},${lon+delta},${lat+delta}`;
    
    // Try multiple layer names
    const layers = [
      "ap:survey", "ap:land_records", "ap:cadastral",
      "ap:survey_boundaries", "ap:plots", "ap:parcels"
    ];
    
    for (const layer of layers) {
      try {
        const url = `https://apsac.ap.gov.in/geoserver/wms?` +
          `SERVICE=WMS&VERSION=1.1.1&REQUEST=GetFeatureInfo` +
          `&LAYERS=${layer}&QUERY_LAYERS=${layer}` +
          `&BBOX=${bbox}&WIDTH=100&HEIGHT=100&X=50&Y=50` +
          `&INFO_FORMAT=application/json&SRS=EPSG:4326`;
        
        const res = await axios.get(url, { timeout: 5000, headers: { "User-Agent": "LandCheck/1.0" } });
        
        if (res.data?.features?.length > 0) {
          const props = res.data.features[0].properties || {};
          const surveyNo = props.survey_no || props.surveyno || props.SURVEY_NO || 
                          props.sy_no || props.SYNO || props.plot_no || "";
          if (surveyNo) {
            return {
              success: true,
              surveyNumber: surveyNo,
              village: props.village_name || props.VILLAGE || "",
              mandal: props.mandal_name || props.MANDAL || "",
              district: props.district_name || props.DISTRICT || "",
              ownerName: props.pattadar_name || props.owner || "",
              layer
            };
          }
        }
      } catch(e) { /* try next layer */ }
    }
    return { success: false };
  } catch(e) {
    return { success: false };
  }
}

// ── Fetch ALL village plots from MeeBhoomi ─────────────────
async function fetchVillagePlots(district, mandal, village) {
  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage","--disable-gpu"],
      timeout: 30000
    });
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120");
    
    // Try village adangal page
    await page.goto("https://meebhoomi.ap.gov.in/VillageAdangal.aspx", {
      waitUntil: "networkidle2", timeout: 25000
    });

    // Fill district/mandal/village dropdowns
    const selects = await page.$$("select");
    for (let i = 0; i < selects.length; i++) {
      const options = await selects[i].$$eval("option", opts => opts.map(o => ({ val: o.value, text: o.text })));
      
      if (i === 0) {
        const match = options.find(o => o.text.toLowerCase().includes(district.toLowerCase()));
        if (match) await selects[i].select(match.val);
        await new Promise(r => setTimeout(r, 1200));
      } else if (i === 1) {
        const match = options.find(o => o.text.toLowerCase().includes(mandal.toLowerCase()));
        if (match) await selects[i].select(match.val);
        await new Promise(r => setTimeout(r, 1200));
      } else if (i === 2) {
        const match = options.find(o => o.text.toLowerCase().includes(village.toLowerCase()));
        if (match) await selects[i].select(match.val);
        await new Promise(r => setTimeout(r, 1200));
      }
    }

    // Try "Entire Village" option
    const radios = await page.$$("input[type='radio']");
    for (const r of radios) {
      const val = await r.evaluate(el => el.value + el.id + el.name).catch(() => "");
      if (val.toLowerCase().includes("village") || val.toLowerCase().includes("entire") || val === "2") {
        await r.click();
        break;
      }
    }

    // Handle captcha
    const captchaImg = await page.$("img[id*='aptcha'], img[src*='aptcha']");
    let captchaSolved = false;

    if (captchaImg && CAPTCHA_KEY) {
      const b64 = await page.evaluate(img => {
        const c = document.createElement("canvas");
        c.width = img.width; c.height = img.height;
        c.getContext("2d").drawImage(img, 0, 0);
        return c.toDataURL("image/png").split(",")[1];
      }, captchaImg).catch(() => null);
      
      if (b64) {
        const solution = await solveCaptcha(b64);
        if (solution) {
          const captchaInput = await page.$("input[id*='aptcha'], input[name*='aptcha']");
          if (captchaInput) {
            await captchaInput.type(solution);
            captchaSolved = true;
          }
        }
      }
    }

    if (captchaSolved || !CAPTCHA_KEY) {
      // Submit
      const btn = await page.$("input[type='submit'], button[type='submit'], input[value='Click']");
      if (btn) {
        await btn.click();
        await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 }).catch(() => {});
      }

      // Extract table data
      const plots = await page.evaluate(() => {
        const results = [];
        document.querySelectorAll("table tbody tr").forEach((row, i) => {
          if (i === 0) return;
          const cells = row.querySelectorAll("td");
          if (cells.length >= 2) {
            results.push({
              surveyNumber: cells[0]?.innerText?.trim() || "",
              ownerName: cells[1]?.innerText?.trim() || cells[2]?.innerText?.trim() || "",
              extent: cells[3]?.innerText?.trim() || cells[2]?.innerText?.trim() || "",
              landType: cells[4]?.innerText?.trim() || "Agricultural",
            });
          }
        });
        return results.filter(r => r.surveyNumber || r.ownerName);
      });

      if (plots.length > 0) {
        return { success: true, source: "meebhoomi_live", plots };
      }
    }

    return { success: false, message: CAPTCHA_KEY ? "Captcha failed" : "No CAPTCHA_API_KEY" };
  } catch(e) {
    console.error("Village fetch error:", e.message);
    return { success: false, message: e.message };
  } finally {
    if (browser) await browser.close();
  }
}

// ── DEMO DATA ──────────────────────────────────────────────
function getDemoPlots(village, district) {
  return [
    { surveyNumber:"441/2A", ownerName:"Ravi Kumar Reddy", extent:"2.50 Acres", landType:"Agricultural",
      riskLevel:"Low", riskScore:12, soilType:"Black Cotton Soil", waterSource:"Canal Irrigation",
      cropGrown:"Paddy", marketValue:"₹45,00,000", ecStatus:"Clear — No encumbrances",
      bankLoan:"No loan", courtCase:"No disputes",
      boundaries:{north:"Survey 441/1 - Gopal Rao",south:"Canal Road",east:"Survey 442",west:"Village Road"},
      previousOwners:["Gopal Rao (1985-2001)","Suresh Rao (2001-2015)","Ravi Kumar Reddy (2015-Now)"] },
    { surveyNumber:"441/3", ownerName:"Suresh Rao", extent:"1.20 Acres", landType:"Agricultural",
      riskLevel:"Medium", riskScore:44, soilType:"Red Soil", waterSource:"Borewell",
      cropGrown:"Cotton", marketValue:"₹22,00,000", ecStatus:"Clear",
      bankLoan:"No loan", courtCase:"Minor boundary dispute",
      boundaries:{north:"Survey 441/2A",south:"Road",east:"Survey 442",west:"Field"},
      previousOwners:["Hanumaiah (1980-2005)","Suresh Rao (2005-Now)"] },
    { surveyNumber:"442/1", ownerName:"Lakshmi Devi", extent:"0.80 Acres", landType:"Residential",
      riskLevel:"High", riskScore:78, soilType:"Black Soil", waterSource:"None",
      cropGrown:"None", marketValue:"₹85,00,000", ecStatus:"⚠ Gap 2005-2012",
      bankLoan:"⚠ SBI Mortgage", courtCase:"⚠ Dispute pending",
      boundaries:{north:"Road",south:"Building",east:"Survey 443",west:"Survey 441"},
      previousOwners:["Ramaiah (1990-2005)","UNKNOWN (2005-2012)","Lakshmi Devi (2012-Now)"] },
    { surveyNumber:"443/2B", ownerName:"Venkata Subba Rao", extent:"3.75 Acres", landType:"Agricultural",
      riskLevel:"Low", riskScore:18, soilType:"Alluvial Soil", waterSource:"Canal + Borewell",
      cropGrown:"Cotton, Chilli", marketValue:"₹62,00,000", ecStatus:"Clear",
      bankLoan:"No loan", courtCase:"No disputes",
      boundaries:{north:"Survey 443/1",south:"Survey 444",east:"Canal",west:"Village Path"},
      previousOwners:["Hanumaiah (1978-1999)","Venkata Subba Rao (1999-Now)"] },
    { surveyNumber:"444/1A", ownerName:"Hanumaiah Naidu", extent:"1.50 Acres", landType:"Agricultural",
      riskLevel:"Low", riskScore:8, soilType:"Sandy Loam", waterSource:"Rain-fed",
      cropGrown:"Groundnut", marketValue:"₹18,00,000", ecStatus:"Clear",
      bankLoan:"No loan", courtCase:"No disputes",
      boundaries:{north:"Survey 443",south:"Survey 445",east:"Road",west:"Field"},
      previousOwners:["Hanumaiah Naidu (1970-Now)"] },
  ];
}

// ══════════════════════════════════════════════════════════
// MAIN API: GPS → Full Auto Land Details
// ══════════════════════════════════════════════════════════
app.get("/gps-to-land", async (req, res) => {
  const { lat, lon } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: "lat and lon required" });

  console.log(`GPS: ${lat}, ${lon}`);

  // Step 1: Get village from GPS (always works - free)
  const geo = await reverseGeocode(lat, lon);
  console.log("Location:", geo.village, geo.district);

  // Step 2: Try APSAC for survey number (free, may work)
  const apsac = await getSurveyFromAPSAC(lat, lon);
  console.log("APSAC result:", apsac.success ? apsac.surveyNumber : "not found");

  // Step 3: Get village plots from MeeBhoomi
  let plots = [];
  let source = "demo";

  if (CAPTCHA_KEY && geo.village) {
    const result = await fetchVillagePlots(
      apsac.district || geo.district,
      apsac.mandal || geo.mandal,
      apsac.village || geo.village
    );
    if (result.success && result.plots?.length > 0) {
      plots = result.plots;
      source = "meebhoomi_live";
    }
  }

  // Use demo if no real data
  if (plots.length === 0) {
    plots = getDemoPlots(geo.village, geo.district);
    source = CAPTCHA_KEY ? "meebhoomi_fallback_demo" : "demo";
  }

  // If APSAC found exact survey number, find that plot
  let exactPlot = null;
  if (apsac.success && apsac.surveyNumber) {
    exactPlot = plots.find(p => p.surveyNumber === apsac.surveyNumber);
  }

  res.json({
    success: true,
    source,
    location: { ...geo, lat: parseFloat(lat), lon: parseFloat(lon) },
    apsacSurveyFound: apsac.success,
    exactPlot,
    plots,
    message: source === "meebhoomi_live"
      ? "Real MeeBhoomi data!"
      : CAPTCHA_KEY
        ? "Add CAPTCHA_API_KEY to Render for real data"
        : "Demo data — Add CAPTCHA_API_KEY to Render env for real data"
  });
});

app.get("/health", (req, res) => res.json({
  status: "ok",
  captcha: !!CAPTCHA_KEY,
  mode: CAPTCHA_KEY ? "REAL DATA MODE" : "DEMO MODE — add CAPTCHA_API_KEY"
}));

app.get("/", (req, res) => res.json({
  name: "LandCheck MeeBhoomi GPS Service",
  endpoints: ["GET /gps-to-land?lat=14.44&lon=79.98", "GET /health"]
}));

app.listen(PORT, () => {
  console.log(`✅ LandCheck MeeBhoomi on port ${PORT}`);
  console.log(CAPTCHA_KEY ? "🟢 REAL DATA MODE" : "🟡 DEMO MODE — add CAPTCHA_API_KEY");
});
