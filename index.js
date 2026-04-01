require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 3001;
const sessions = {};

// ── Reverse geocode ────────────────────────────────────────
async function reverseGeocode(lat, lon) {
  try {
    const res = await axios.get(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1`,
      { headers: { "User-Agent": "LandCheck/1.0 contact@landcheck.in" }, timeout: 8000 }
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

// ── Load MeeBhoomi with full browser headers ───────────────
async function loadMeeBhoomi() {
  const headers = {
    "User-Agent": "Mozilla/5.0 (Linux; Android 10; SM-G975F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "te-IN,te;q=0.9,en-IN;q=0.8,en;q=0.7",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Cache-Control": "max-age=0",
  };

  const res = await axios.get("https://meebhoomi.ap.gov.in/Adangal.aspx", {
    headers, timeout: 25000,
    maxRedirects: 5,
    validateStatus: s => s < 500
  });

  console.log("MeeBhoomi status:", res.status);
  console.log("Response length:", res.data?.length);

  const cookies = res.headers["set-cookie"]?.map(c => c.split(";")[0]).join("; ") || "";
  const $ = cheerio.load(res.data);
  const vs = $("#__VIEWSTATE").val() || $("input[name='__VIEWSTATE']").val() || "";
  const evv = $("#__EVENTVALIDATION").val() || $("input[name='__EVENTVALIDATION']").val() || "";
  const vsg = $("#__VIEWSTATEGENERATOR").val() || $("input[name='__VIEWSTATEGENERATOR']").val() || "";

  console.log("ViewState length:", vs.length);
  console.log("Cookies:", cookies.substring(0,50));

  return { headers, cookies, vs, evv, vsg, $, status: res.status };
}

// ── Get captcha endpoint ───────────────────────────────────
app.get("/get-captcha", async (req, res) => {
  const { lat, lon } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: "lat and lon required" });

  console.log(`\n=== Get Captcha: ${lat}, ${lon} ===`);

  try {
    const geo = await reverseGeocode(lat, lon);
    console.log("Location:", geo.village, geo.district);

    // Load MeeBhoomi
    const mb = await loadMeeBhoomi();

    if (!mb.vs) {
      console.log("No viewstate — MeeBhoomi response:", mb.status);
      return res.json({
        success: false,
        message: `MeeBhoomi returned status ${mb.status}. Site may be down.`,
        location: geo
      });
    }

    // Get districts
    const distOpts = [];
    mb.$("#ctl00_ContentPlaceHolder1_DropDownList1 option").each((i, el) => {
      const v = mb.$(el).val(); const t = mb.$(el).text().trim();
      if (v) distOpts.push({ v, t });
    });
    console.log("Districts found:", distOpts.length, distOpts.slice(0,3).map(o=>o.t));

    if (distOpts.length === 0) {
      return res.json({ success: false, message: "MeeBhoomi dropdowns not loaded. Site may have changed.", location: geo });
    }

    // Match district
    const distMatch = distOpts.find(o =>
      o.t.toLowerCase().replace(/\s+/g,"").includes(geo.district.toLowerCase().replace(/\s+/g,"").substring(0,5)) ||
      geo.district.toLowerCase().replace(/\s+/g,"").includes(o.t.toLowerCase().replace(/\s+/g,"").substring(0,5))
    );

    if (!distMatch) {
      return res.json({
        success: false,
        message: `District "${geo.district}" not in MeeBhoomi. Available: ${distOpts.slice(1,4).map(o=>o.t).join(", ")}`,
        location: geo,
        availableDistricts: distOpts.map(o=>o.t)
      });
    }
    console.log("District matched:", distMatch.t);

    const postHeaders = {
      ...mb.headers,
      "Content-Type": "application/x-www-form-urlencoded",
      "Cookie": mb.cookies,
      "Referer": "https://meebhoomi.ap.gov.in/Adangal.aspx",
      "Origin": "https://meebhoomi.ap.gov.in",
    };

    // Select district → get mandals
    const r2 = await axios.post("https://meebhoomi.ap.gov.in/Adangal.aspx",
      new URLSearchParams({
        "__EVENTTARGET": "ctl00$ContentPlaceHolder1$DropDownList1",
        "__EVENTARGUMENT": "", "__VIEWSTATE": mb.vs,
        "__VIEWSTATEGENERATOR": mb.vsg, "__EVENTVALIDATION": mb.evv,
        "ctl00$ContentPlaceHolder1$DropDownList1": distMatch.v,
        "ctl00$ContentPlaceHolder1$DropDownList2": "",
        "ctl00$ContentPlaceHolder1$DropDownList3": "",
      }).toString(),
      { headers: postHeaders, timeout: 20000, maxRedirects: 5, validateStatus: s => s < 500 }
    );
    const $2 = cheerio.load(r2.data);
    const vs2 = $2("#__VIEWSTATE").val() || mb.vs;
    const evv2 = $2("#__EVENTVALIDATION").val() || mb.evv;

    const mandalOpts = [];
    $2("#ctl00_ContentPlaceHolder1_DropDownList2 option").each((i, el) => {
      const v=$2(el).val(); const t=$2(el).text().trim(); if(v) mandalOpts.push({v,t});
    });
    console.log("Mandals:", mandalOpts.length);

    const mandalMatch = mandalOpts.find(o =>
      o.t.toLowerCase().includes(geo.mandal.toLowerCase().split(" ")[0]) ||
      geo.mandal.toLowerCase().includes(o.t.toLowerCase().split(" ")[0])
    ) || mandalOpts[1];
    if (!mandalMatch) return res.json({ success: false, message: `Mandal "${geo.mandal}" not found`, location: geo });
    console.log("Mandal:", mandalMatch.t);

    // Select mandal → get villages
    const r3 = await axios.post("https://meebhoomi.ap.gov.in/Adangal.aspx",
      new URLSearchParams({
        "__EVENTTARGET": "ctl00$ContentPlaceHolder1$DropDownList2",
        "__EVENTARGUMENT": "", "__VIEWSTATE": vs2,
        "__VIEWSTATEGENERATOR": mb.vsg, "__EVENTVALIDATION": evv2,
        "ctl00$ContentPlaceHolder1$DropDownList1": distMatch.v,
        "ctl00$ContentPlaceHolder1$DropDownList2": mandalMatch.v,
        "ctl00$ContentPlaceHolder1$DropDownList3": "",
      }).toString(),
      { headers: postHeaders, timeout: 20000, maxRedirects: 5, validateStatus: s => s < 500 }
    );
    const $3 = cheerio.load(r3.data);
    const vs3 = $3("#__VIEWSTATE").val() || vs2;
    const evv3 = $3("#__EVENTVALIDATION").val() || evv2;

    const villageOpts = [];
    $3("#ctl00_ContentPlaceHolder1_DropDownList3 option").each((i, el) => {
      const v=$3(el).val(); const t=$3(el).text().trim(); if(v) villageOpts.push({v,t});
    });
    console.log("Villages:", villageOpts.length);

    const villageMatch = villageOpts.find(o =>
      o.t.toLowerCase().includes(geo.village.toLowerCase().split(" ")[0]) ||
      geo.village.toLowerCase().includes(o.t.toLowerCase().split(" ")[0])
    ) || villageOpts[1];
    if (!villageMatch) return res.json({ success: false, message: `Village "${geo.village}" not found`, location: geo });
    console.log("Village:", villageMatch.t);

    // Select village → get captcha
    const r4 = await axios.post("https://meebhoomi.ap.gov.in/Adangal.aspx",
      new URLSearchParams({
        "__EVENTTARGET": "ctl00$ContentPlaceHolder1$DropDownList3",
        "__EVENTARGUMENT": "", "__VIEWSTATE": vs3,
        "__VIEWSTATEGENERATOR": mb.vsg, "__EVENTVALIDATION": evv3,
        "ctl00$ContentPlaceHolder1$DropDownList1": distMatch.v,
        "ctl00$ContentPlaceHolder1$DropDownList2": mandalMatch.v,
        "ctl00$ContentPlaceHolder1$DropDownList3": villageMatch.v,
      }).toString(),
      { headers: postHeaders, timeout: 20000, maxRedirects: 5, validateStatus: s => s < 500 }
    );
    const $4 = cheerio.load(r4.data);
    const vs4 = $4("#__VIEWSTATE").val() || vs3;
    const evv4 = $4("#__EVENTVALIDATION").val() || evv3;

    // Get captcha image
    let captchaBase64 = "";
    const captchaEl = $4("img[id*='aptcha'], img[id*='Captcha'], img[src*='aptcha'], img[src*='Captcha']");
    const captchaImgSrc = captchaEl.attr("src") || "";
    console.log("Captcha element found:", captchaEl.length, "src:", captchaImgSrc);

    if (captchaImgSrc) {
      const captchaUrl = captchaImgSrc.startsWith("http") ? captchaImgSrc
        : `https://meebhoomi.ap.gov.in/${captchaImgSrc.replace(/^\//, "")}`;
      try {
        const imgRes = await axios.get(captchaUrl, {
          responseType: "arraybuffer",
          headers: { ...postHeaders, "Accept": "image/webp,image/apng,image/*,*/*;q=0.8" },
          timeout: 10000
        });
        captchaBase64 = Buffer.from(imgRes.data).toString("base64");
        console.log("Captcha downloaded, bytes:", captchaBase64.length);
      } catch(e) { console.log("Captcha download error:", e.message); }
    }

    // Save session
    const sessionId = Date.now().toString();
    sessions[sessionId] = {
      cookies: mb.cookies, vs: vs4, evv: evv4, vsg: mb.vsg,
      distVal: distMatch.v, mandalVal: mandalMatch.v, villageVal: villageMatch.v,
      distName: distMatch.t, mandalName: mandalMatch.t, villageName: villageMatch.t,
      location: geo, created: Date.now()
    };
    Object.keys(sessions).forEach(k => { if (Date.now() - sessions[k].created > 300000) delete sessions[k]; });

    res.json({
      success: true, sessionId,
      captchaImage: captchaBase64 ? `data:image/png;base64,${captchaBase64}` : "",
      location: geo,
      detected: { district: distMatch.t, mandal: mandalMatch.t, village: villageMatch.t },
      message: captchaBase64 ? "Enter captcha!" : "No captcha image found — try submitting"
    });

  } catch(e) {
    console.error("get-captcha error:", e.message, e.code, e.response?.status);
    res.json({
      success: false,
      message: `MeeBhoomi error: ${e.message || e.code || "Connection failed"}. Status: ${e.response?.status || "no response"}`
    });
  }
});

// ── Submit captcha ─────────────────────────────────────────
app.post("/submit-captcha", async (req, res) => {
  const { sessionId, captcha } = req.body;
  if (!sessionId || !captcha) return res.status(400).json({ error: "sessionId and captcha required" });
  const session = sessions[sessionId];
  if (!session) return res.status(400).json({ error: "Session expired. Please try again." });

  console.log(`\n=== Submit Captcha: "${captcha}" ===`);

  try {
    const headers = {
      "User-Agent": "Mozilla/5.0 (Linux; Android 10; SM-G975F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
      "Content-Type": "application/x-www-form-urlencoded",
      "Cookie": session.cookies,
      "Referer": "https://meebhoomi.ap.gov.in/Adangal.aspx",
      "Origin": "https://meebhoomi.ap.gov.in",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    };

    const result = await axios.post("https://meebhoomi.ap.gov.in/Adangal.aspx",
      new URLSearchParams({
        "__EVENTTARGET": "", "__EVENTARGUMENT": "",
        "__VIEWSTATE": session.vs, "__VIEWSTATEGENERATOR": session.vsg, "__EVENTVALIDATION": session.evv,
        "ctl00$ContentPlaceHolder1$DropDownList1": session.distVal,
        "ctl00$ContentPlaceHolder1$DropDownList2": session.mandalVal,
        "ctl00$ContentPlaceHolder1$DropDownList3": session.villageVal,
        "ctl00$ContentPlaceHolder1$RadioButtonList1": "2",
        "ctl00$ContentPlaceHolder1$TextBox1": captcha,
        "ctl00$ContentPlaceHolder1$Button1": "Click",
      }).toString(),
      { headers, timeout: 30000, maxRedirects: 5, validateStatus: s => s < 500 }
    );

    console.log("Submit status:", result.status, "Response length:", result.data?.length);
    const $ = cheerio.load(result.data);

    // Check error
    const pageText = $.text().toLowerCase();
    if (pageText.includes("invalid captcha") || pageText.includes("wrong captcha") || pageText.includes("incorrect")) {
      return res.json({ success: false, wrongCaptcha: true, message: "Wrong captcha! Try again." });
    }

    // Extract plots from table
    const plots = [];
    $("table tr").each((i, row) => {
      if (i === 0) return;
      const cells = $(row).find("td");
      if (cells.length >= 2) {
        const survey = $(cells[0]).text().trim();
        const owner = $(cells[1]).text().trim();
        const extent = $(cells[2]).text().trim();
        const landType = $(cells[3]).text().trim() || "Agricultural";
        if (survey && owner && survey.length > 0 && owner.length > 1 &&
            !/survey|owner|khata|సర్వే/i.test(survey)) {
          plots.push({
            surveyNumber: survey, ownerName: owner, extent: extent || "—", landType,
            village: session.villageName, mandal: session.mandalName, district: session.distName
          });
        }
      }
    });

    console.log("Plots found:", plots.length);
    if (plots.length > 0) {
      delete sessions[sessionId];
      return res.json({ success: true, source: "meebhoomi_live", plots, message: `✅ ${plots.length} real plots!` });
    }

    // No plots — maybe wrong captcha or empty village
    const errorText = $(".error, #lblMessage, span[id*='Error']").text().trim();
    return res.json({ success: false, wrongCaptcha: true, message: errorText || "No plots found. Wrong captcha?" });

  } catch(e) {
    console.error("submit error:", e.message, e.code);
    res.json({ success: false, message: `Submit error: ${e.message || e.code}` });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok", mode: "SEMI-AUTO v5" }));
app.get("/", (req, res) => res.json({ name: "LandCheck MeeBhoomi v5" }));

app.listen(PORT, () => console.log(`✅ LandCheck on port ${PORT}`));
