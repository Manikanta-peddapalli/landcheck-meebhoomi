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

// ═══════════════════════════════════════════════════════════
// STEP 1: GPS → Village name (Nominatim - FREE)
// ═══════════════════════════════════════════════════════════
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
      raw: addr
    };
  } catch(e) {
    console.error("Geocode error:", e.message);
    return { village:"", mandal:"", district:"", state:"Andhra Pradesh" };
  }
}

// ═══════════════════════════════════════════════════════════
// STEP 2: GPS → Survey Number (APSAC GeoServer WMS)
// ═══════════════════════════════════════════════════════════
async function getSurveyFromGPS(lat, lon) {
  try {
    // Convert lat/lon to WMS pixel coordinates
    // APSAC GeoServer WMS GetFeatureInfo
    const bbox = `${lon-0.001},${lat-0.001},${lon+0.001},${lat+0.001}`;
    const url = `https://apsac.ap.gov.in/geoserver/wms?` +
      `SERVICE=WMS&VERSION=1.1.1&REQUEST=GetFeatureInfo` +
      `&LAYERS=ap:survey_boundaries` +
      `&QUERY_LAYERS=ap:survey_boundaries` +
      `&BBOX=${bbox}` +
      `&WIDTH=100&HEIGHT=100` +
      `&X=50&Y=50` +
      `&INFO_FORMAT=application/json` +
      `&SRS=EPSG:4326`;

    const res = await axios.get(url, {
      timeout: 10000,
      headers: { "User-Agent": "LandCheck/1.0" }
    });

    if (res.data && res.data.features && res.data.features.length > 0) {
      const feature = res.data.features[0];
      const props = feature.properties || {};
      return {
        success: true,
        surveyNumber: props.survey_no || props.surveyno || props.SURVEY_NO || props.sy_no || "",
        village: props.village_name || props.VILLAGE || "",
        mandal: props.mandal_name || props.MANDAL || "",
        district: props.district_name || props.DISTRICT || "",
        ownerName: props.pattadar_name || props.OWNER || "",
        extent: props.extent || props.area || "",
        raw: props
      };
    }
    return { success: false, message: "No survey found at this location" };
  } catch(e) {
    console.error("APSAC WMS error:", e.message);
    return { success: false, message: e.message };
  }
}

// ═══════════════════════════════════════════════════════════
// STEP 3: Survey Number → Full Details (MeeBhoomi scraper)
// ═══════════════════════════════════════════════════════════
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

async function fetchMeeBhoomiFull(district, mandal, village, surveyNo) {
  if (!CAPTCHA_KEY) {
    // Demo mode
    return {
      success: true, source: "demo",
      surveyNumber: surveyNo, village, mandal, district,
      ownerName: "Real data needs 2captcha API key",
      extentAcres: 2.5, landType: "Agricultural",
      soilType: "Black Cotton Soil", waterSource: "Canal",
      cropGrown: "Paddy", marketValue: "₹35,00,000",
      ecStatus: "Add CAPTCHA_API_KEY for real data",
      bankLoan: "Add CAPTCHA_API_KEY for real data",
      courtCase: "Add CAPTCHA_API_KEY for real data",
      previousOwners: ["Add CAPTCHA_API_KEY for real data"],
      riskLevel: "Low", riskScore: 15,
      boundaries: { north:"—", south:"—", east:"—", west:"—" }
    };
  }

  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage","--disable-gpu"]
    });
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120");
    await page.goto("https://meebhoomi.ap.gov.in/Home.aspx", {
      waitUntil: "networkidle2", timeout: 30000
    });

    // Navigate to Adangal
    await page.goto("https://meebhoomi.ap.gov.in/Adangal.aspx", {
      waitUntil: "networkidle2", timeout: 20000
    });

    // Fill form
    const selects = await page.$$("select");
    if (selects[0]) await selects[0].select(district).catch(() => {});
    await new Promise(r => setTimeout(r, 1200));
    if (selects[1]) await selects[1].select(mandal).catch(() => {});
    await new Promise(r => setTimeout(r, 1200));
    if (selects[2]) await selects[2].select(village).catch(() => {});
    await new Promise(r => setTimeout(r, 1200));

    // Select survey number radio
    const radios = await page.$$("input[type='radio']");
    for (const r of radios) {
      const val = await r.evaluate(el => el.value).catch(() => "");
      if (val.toLowerCase().includes("survey") || val === "1") {
        await r.click();
        break;
      }
    }

    // Enter survey number
    const inputs = await page.$$("input[type='text']");
    for (const inp of inputs) {
      const id = await inp.evaluate(el => el.id.toLowerCase()).catch(() => "");
      if (id.includes("survey") || id.includes("no")) {
        await inp.clear();
        await inp.type(surveyNo);
        break;
      }
    }

    // Get captcha image
    const captchaImg = await page.$("img[id*='aptcha']");
    let captchaSolution = null;
    if (captchaImg) {
      const b64 = await page.evaluate(img => {
        const c = document.createElement("canvas");
        c.width = img.width; c.height = img.height;
        c.getContext("2d").drawImage(img, 0, 0);
        return c.toDataURL("image/png").split(",")[1];
      }, captchaImg).catch(() => null);
      if (b64) captchaSolution = await solveCaptcha(b64);
    }

    if (captchaSolution) {
      const captchaInput = await page.$("input[id*='aptcha']");
      if (captchaInput) await captchaInput.type(captchaSolution);

      const submitBtn = await page.$("input[type='submit'], button[type='submit']");
      if (submitBtn) {
        await submitBtn.click();
        await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 });
      }

      // Extract all data from result
      const data = await page.evaluate(() => {
        const result = {};
        document.querySelectorAll("table tr").forEach(row => {
          const cells = row.querySelectorAll("td");
          if (cells.length >= 2) {
            result[cells[0].innerText.trim()] = cells[1].innerText.trim();
          }
        });
        return result;
      });

      return {
        success: true, source: "meebhoomi_live",
        surveyNumber: surveyNo, village, mandal, district,
        rawData: data
      };
    }

    return { success: false, message: "Captcha solving failed" };
  } catch(e) {
    return { success: false, message: e.message };
  } finally {
    if (browser) await browser.close();
  }
}

// ═══════════════════════════════════════════════════════════
// MAIN ROUTE: GPS → Full Automatic
// ═══════════════════════════════════════════════════════════
app.get("/gps-to-land", async (req, res) => {
  const { lat, lon } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: "lat and lon required" });

  console.log(`GPS request: ${lat}, ${lon}`);

  try {
    // Step 1: Get village from GPS
    const geo = await reverseGeocode(lat, lon);
    console.log("Village detected:", geo.village, geo.district);

    // Step 2: Get survey number from APSAC
    const survey = await getSurveyFromGPS(lat, lon);
    console.log("Survey result:", survey);

    if (survey.success && survey.surveyNumber) {
      // Step 3: Get full details from MeeBhoomi
      const details = await fetchMeeBhoomiFull(
        survey.district || geo.district,
        survey.mandal || geo.mandal,
        survey.village || geo.village,
        survey.surveyNumber
      );
      return res.json({
        success: true,
        location: geo,
        surveyNumber: survey.surveyNumber,
        ownerName: survey.ownerName || details.ownerName,
        ...details
      });
    }

    // APSAC didn't return survey — return village info + demo
    return res.json({
      success: true,
      source: "partial",
      location: geo,
      message: "Village detected. Survey number lookup needs APSAC API access.",
      village: geo.village,
      mandal: geo.mandal,
      district: geo.district,
      // Demo plots for this village
      villagePlots: [
        { surveyNumber: "441/2A", ownerName: "Real data needs APSAC API", extent: "2.50 Acres" },
        { surveyNumber: "441/3",  ownerName: "Add 2captcha for real data",  extent: "1.20 Acres" },
      ]
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/health", (req, res) => res.json({
  status: "ok",
  captcha: !!CAPTCHA_KEY,
  message: CAPTCHA_KEY ? "Real data mode!" : "Demo mode"
}));

app.get("/", (req, res) => res.json({
  name: "LandCheck GPS → MeeBhoomi Auto Service",
  endpoints: [
    "GET /gps-to-land?lat=14.44&lon=79.98",
    "GET /health"
  ]
}));

app.listen(PORT, () => {
  console.log(`✅ LandCheck GPS→Land service on port ${PORT}`);
});
