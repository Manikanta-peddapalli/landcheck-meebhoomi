require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 3001;
const CAPTCHA_KEY = process.env.CAPTCHA_API_KEY || "";

console.log("Mode:", CAPTCHA_KEY ? "REAL DATA" : "DEMO");

// ── Reverse geocode GPS → village ──────────────────────────
async function reverseGeocode(lat, lon) {
  try {
    const res = await axios.get(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1`,
      { headers: { "User-Agent": "LandCheck/1.0" }, timeout: 8000 }
    );
    const a = res.data.address || {};
    return {
      village: a.village || a.hamlet || a.suburb || a.town || a.city || "",
      mandal: a.county || a.state_district || "",
      district: a.state_district || a.county || "",
      state: "Andhra Pradesh"
    };
  } catch(e) {
    return { village:"", mandal:"", district:"", state:"Andhra Pradesh" };
  }
}

// ── Solve captcha ──────────────────────────────────────────
async function solveCaptcha(imageUrl, cookies) {
  if (!CAPTCHA_KEY) return null;
  try {
    // Download captcha image
    const imgRes = await axios.get(imageUrl, {
      responseType: "arraybuffer",
      headers: { "Cookie": cookies, "Referer": "https://meebhoomi.ap.gov.in/" }
    });
    const b64 = Buffer.from(imgRes.data).toString("base64");

    // Submit to 2captcha
    const sub = await axios.post("http://2captcha.com/in.php", {
      key: CAPTCHA_KEY, method: "base64", body: b64, json: 1
    });
    if (sub.data.status !== 1) return null;
    const id = sub.data.request;

    // Wait for solution
    for (let i = 0; i < 8; i++) {
      await new Promise(r => setTimeout(r, 4000));
      const sol = await axios.get(
        `http://2captcha.com/res.php?key=${CAPTCHA_KEY}&action=get&id=${id}&json=1`
      );
      if (sol.data.status === 1) {
        console.log("Captcha solved:", sol.data.request);
        return sol.data.request;
      }
    }
    return null;
  } catch(e) {
    console.log("Captcha error:", e.message);
    return null;
  }
}

// ── Fetch MeeBhoomi with Cheerio (lightweight!) ────────────
async function fetchMeeBhoomi(district, mandal, village) {
  try {
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
      "Connection": "keep-alive"
    };

    // Step 1: Load page
    console.log("Loading MeeBhoomi...");
    const page1 = await axios.get("https://meebhoomi.ap.gov.in/Adangal.aspx", {
      headers, timeout: 20000
    });
    const cookies = page1.headers["set-cookie"]?.map(c => c.split(";")[0]).join("; ") || "";
    const $ = cheerio.load(page1.data);

    // Extract form fields
    const vs = $("#__VIEWSTATE").val() || "";
    const evv = $("#__EVENTVALIDATION").val() || "";
    const vsg = $("#__VIEWSTATEGENERATOR").val() || "";

    if (!vs) { console.log("No viewstate!"); return null; }
    console.log("Page loaded, viewstate length:", vs.length);

    // Get district options
    const distOpts = [];
    $("#ctl00_ContentPlaceHolder1_DropDownList1 option").each((i, el) => {
      distOpts.push({ v: $(el).val(), t: $(el).text().trim() });
    });
    console.log("Districts found:", distOpts.length);

    const distMatch = distOpts.find(o =>
      o.t.toLowerCase().includes(district.toLowerCase().replace(" district","").split(" ")[0]) ||
      district.toLowerCase().includes(o.t.toLowerCase().split(" ")[0])
    );
    if (!distMatch || !distMatch.v) {
      console.log("District not found:", district, "Available:", distOpts.slice(0,5).map(o=>o.t));
      return null;
    }
    console.log("District matched:", distMatch.t);

    // Step 2: Select district
    const page2 = await axios.post(
      "https://meebhoomi.ap.gov.in/Adangal.aspx",
      new URLSearchParams({
        "__EVENTTARGET": "ctl00$ContentPlaceHolder1$DropDownList1",
        "__EVENTARGUMENT": "",
        "__VIEWSTATE": vs,
        "__VIEWSTATEGENERATOR": vsg,
        "__EVENTVALIDATION": evv,
        "ctl00$ContentPlaceHolder1$DropDownList1": distMatch.v,
        "ctl00$ContentPlaceHolder1$DropDownList2": "",
        "ctl00$ContentPlaceHolder1$DropDownList3": "",
      }).toString(),
      { headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded", "Cookie": cookies, "Referer": "https://meebhoomi.ap.gov.in/Adangal.aspx" }, timeout: 20000 }
    );

    const $2 = cheerio.load(page2.data);
    const vs2 = $2("#__VIEWSTATE").val() || vs;
    const evv2 = $2("#__EVENTVALIDATION").val() || evv;

    // Get mandal options
    const mandalOpts = [];
    $2("#ctl00_ContentPlaceHolder1_DropDownList2 option").each((i, el) => {
      mandalOpts.push({ v: $2(el).val(), t: $2(el).text().trim() });
    });
    console.log("Mandals found:", mandalOpts.length);

    const mandalMatch = mandalOpts.find(o =>
      o.t.toLowerCase().includes(mandal.toLowerCase().split(" ")[0]) ||
      mandal.toLowerCase().includes(o.t.toLowerCase().split(" ")[0])
    ) || mandalOpts[1]; // fallback to first real option

    if (!mandalMatch || !mandalMatch.v) {
      console.log("Mandal not found:", mandal);
      return null;
    }
    console.log("Mandal matched:", mandalMatch.t);

    // Step 3: Select mandal
    const page3 = await axios.post(
      "https://meebhoomi.ap.gov.in/Adangal.aspx",
      new URLSearchParams({
        "__EVENTTARGET": "ctl00$ContentPlaceHolder1$DropDownList2",
        "__EVENTARGUMENT": "",
        "__VIEWSTATE": vs2,
        "__VIEWSTATEGENERATOR": vsg,
        "__EVENTVALIDATION": evv2,
        "ctl00$ContentPlaceHolder1$DropDownList1": distMatch.v,
        "ctl00$ContentPlaceHolder1$DropDownList2": mandalMatch.v,
        "ctl00$ContentPlaceHolder1$DropDownList3": "",
      }).toString(),
      { headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded", "Cookie": cookies, "Referer": "https://meebhoomi.ap.gov.in/Adangal.aspx" }, timeout: 20000 }
    );

    const $3 = cheerio.load(page3.data);
    const vs3 = $3("#__VIEWSTATE").val() || vs2;
    const evv3 = $3("#__EVENTVALIDATION").val() || evv2;

    // Get village options
    const villageOpts = [];
    $3("#ctl00_ContentPlaceHolder1_DropDownList3 option").each((i, el) => {
      villageOpts.push({ v: $3(el).val(), t: $3(el).text().trim() });
    });
    console.log("Villages found:", villageOpts.length);

    const villageMatch = villageOpts.find(o =>
      o.t.toLowerCase().includes(village.toLowerCase().split(" ")[0]) ||
      village.toLowerCase().includes(o.t.toLowerCase().split(" ")[0])
    ) || villageOpts[1];

    if (!villageMatch || !villageMatch.v) {
      console.log("Village not found:", village);
      return null;
    }
    console.log("Village matched:", villageMatch.t);

    // Step 4: Select village + entire village radio
    const page4 = await axios.post(
      "https://meebhoomi.ap.gov.in/Adangal.aspx",
      new URLSearchParams({
        "__EVENTTARGET": "ctl00$ContentPlaceHolder1$DropDownList3",
        "__EVENTARGUMENT": "",
        "__VIEWSTATE": vs3,
        "__VIEWSTATEGENERATOR": vsg,
        "__EVENTVALIDATION": evv3,
        "ctl00$ContentPlaceHolder1$DropDownList1": distMatch.v,
        "ctl00$ContentPlaceHolder1$DropDownList2": mandalMatch.v,
        "ctl00$ContentPlaceHolder1$DropDownList3": villageMatch.v,
      }).toString(),
      { headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded", "Cookie": cookies, "Referer": "https://meebhoomi.ap.gov.in/Adangal.aspx" }, timeout: 20000 }
    );

    const $4 = cheerio.load(page4.data);
    const vs4 = $4("#__VIEWSTATE").val() || vs3;
    const evv4 = $4("#__EVENTVALIDATION").val() || evv3;

    // Get captcha image URL
    const captchaImgSrc = $4("img[id*='aptcha'], img[id*='Captcha']").attr("src") || "";
    const captchaImgUrl = captchaImgSrc ? `https://meebhoomi.ap.gov.in/${captchaImgSrc.replace(/^\//, "")}` : "";
    console.log("Captcha image:", captchaImgUrl);

    // Solve captcha
    let captchaSolution = "";
    if (captchaImgUrl && CAPTCHA_KEY) {
      captchaSolution = await solveCaptcha(captchaImgUrl, cookies) || "";
    }

    if (!captchaSolution) {
      console.log("Could not solve captcha");
      return null;
    }

    // Step 5: Submit form with entire village
    const submitData = new URLSearchParams({
      "__EVENTTARGET": "",
      "__EVENTARGUMENT": "",
      "__VIEWSTATE": vs4,
      "__VIEWSTATEGENERATOR": vsg,
      "__EVENTVALIDATION": evv4,
      "ctl00$ContentPlaceHolder1$DropDownList1": distMatch.v,
      "ctl00$ContentPlaceHolder1$DropDownList2": mandalMatch.v,
      "ctl00$ContentPlaceHolder1$DropDownList3": villageMatch.v,
      "ctl00$ContentPlaceHolder1$RadioButtonList1": "2", // Entire village
      "ctl00$ContentPlaceHolder1$TextBox1": captchaSolution,
      "ctl00$ContentPlaceHolder1$Button1": "Click",
    });

    console.log("Submitting form with captcha:", captchaSolution);
    const result = await axios.post(
      "https://meebhoomi.ap.gov.in/Adangal.aspx",
      submitData.toString(),
      { headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded", "Cookie": cookies, "Referer": "https://meebhoomi.ap.gov.in/Adangal.aspx" }, timeout: 25000 }
    );

    // Parse results
    const $5 = cheerio.load(result.data);
    const plots = [];

    $5("table tr").each((i, row) => {
      if (i === 0) return;
      const cells = $5(row).find("td");
      if (cells.length >= 2) {
        const survey = $5(cells[0]).text().trim();
        const owner = $5(cells[1]).text().trim();
        const extent = $5(cells[2]).text().trim() || $5(cells[3]).text().trim();
        if (survey && owner && survey !== "Survey No" && owner.length > 1) {
          plots.push({
            surveyNumber: survey,
            ownerName: owner,
            extent: extent || "—",
            landType: "Agricultural",
            village: villageMatch.t,
            mandal: mandalMatch.t,
            district: distMatch.t
          });
        }
      }
    });

    console.log("Real plots found:", plots.length);
    return plots.length > 0 ? plots : null;

  } catch(e) {
    console.log("MeeBhoomi fetch error:", e.message);
    return null;
  }
}

// ── Demo data ──────────────────────────────────────────────
function getDemoPlots() {
  return [
    { surveyNumber:"441/2A", ownerName:"Ravi Kumar Reddy", extent:"2.50 Acres", landType:"Agricultural", riskLevel:"Low", riskScore:12, soilType:"Black Cotton Soil", waterSource:"Canal Irrigation", cropGrown:"Paddy", marketValue:"₹45,00,000", ecStatus:"Clear", bankLoan:"No loan", courtCase:"No disputes", boundaries:{north:"Survey 441/1",south:"Canal Road",east:"Survey 442",west:"Village Road"}, previousOwners:["Gopal Rao (1985-2001)","Suresh Rao (2001-2015)","Ravi Kumar Reddy (2015-Now)"] },
    { surveyNumber:"441/3", ownerName:"Suresh Rao", extent:"1.20 Acres", landType:"Agricultural", riskLevel:"Medium", riskScore:44, soilType:"Red Soil", waterSource:"Borewell", cropGrown:"Cotton", marketValue:"₹22,00,000", ecStatus:"Clear", bankLoan:"No loan", courtCase:"Minor dispute", boundaries:{north:"Survey 441/2A",south:"Road",east:"Survey 442",west:"Field"}, previousOwners:["Hanumaiah (1980-2005)","Suresh Rao (2005-Now)"] },
    { surveyNumber:"442/1", ownerName:"Lakshmi Devi", extent:"0.80 Acres", landType:"Residential", riskLevel:"High", riskScore:78, soilType:"Black Soil", waterSource:"None", cropGrown:"None", marketValue:"₹85,00,000", ecStatus:"⚠ Gap 2005-2012", bankLoan:"⚠ SBI Mortgage", courtCase:"⚠ Dispute pending", boundaries:{north:"Road",south:"Building",east:"Survey 443",west:"Survey 441"}, previousOwners:["Ramaiah (1990-2005)","UNKNOWN (2005-2012)","Lakshmi Devi (2012-Now)"] },
    { surveyNumber:"443/2B", ownerName:"Venkata Subba Rao", extent:"3.75 Acres", landType:"Agricultural", riskLevel:"Low", riskScore:18, soilType:"Alluvial Soil", waterSource:"Canal + Borewell", cropGrown:"Cotton, Chilli", marketValue:"₹62,00,000", ecStatus:"Clear", bankLoan:"No loan", courtCase:"No disputes", boundaries:{north:"Survey 443/1",south:"Survey 444",east:"Canal",west:"Village Path"}, previousOwners:["Hanumaiah (1978-1999)","Venkata Subba Rao (1999-Now)"] },
    { surveyNumber:"444/1A", ownerName:"Hanumaiah Naidu", extent:"1.50 Acres", landType:"Agricultural", riskLevel:"Low", riskScore:8, soilType:"Sandy Loam", waterSource:"Rain-fed", cropGrown:"Groundnut", marketValue:"₹18,00,000", ecStatus:"Clear", bankLoan:"No loan", courtCase:"No disputes", boundaries:{north:"Survey 443",south:"Survey 445",east:"Road",west:"Field"}, previousOwners:["Hanumaiah Naidu (1970-Now)"] },
  ];
}

// ── MAIN ───────────────────────────────────────────────────
app.get("/gps-to-land", async (req, res) => {
  const { lat, lon } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: "lat and lon required" });

  console.log(`\n=== GPS: ${lat}, ${lon} ===`);
  const geo = await reverseGeocode(lat, lon);
  console.log("Location:", geo.village, geo.district);

  let plots = null;
  let source = "demo";

  if (CAPTCHA_KEY && geo.village && geo.district) {
    console.log("Attempting real MeeBhoomi fetch...");
    plots = await fetchMeeBhoomi(geo.district, geo.mandal, geo.village);
    if (plots) source = "meebhoomi_live";
  }

  if (!plots) {
    plots = getDemoPlots();
    source = "demo";
  }

  res.json({
    success: true,
    source,
    location: { ...geo, lat: parseFloat(lat), lon: parseFloat(lon) },
    plots,
    message: source === "meebhoomi_live" ? "✅ Real MeeBhoomi data!" : `Demo data shown for ${geo.village || "your location"}`
  });
});

app.get("/health", (req, res) => res.json({
  status: "ok", captcha: !!CAPTCHA_KEY,
  mode: CAPTCHA_KEY ? "REAL DATA MODE" : "DEMO MODE"
}));

app.get("/", (req, res) => res.json({ name: "LandCheck MeeBhoomi GPS Service v3" }));

app.listen(PORT, () => {
  console.log(`✅ LandCheck MeeBhoomi on port ${PORT}`);
  console.log(CAPTCHA_KEY ? "🟢 REAL DATA MODE" : "🔴 DEMO MODE");
});
