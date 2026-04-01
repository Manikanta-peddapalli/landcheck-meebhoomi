require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 3001;

// Store sessions temporarily
const sessions = {};

// ── Reverse geocode ────────────────────────────────────────
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

// ── STEP 1: GPS → Get captcha image from MeeBhoomi ─────────
app.get("/get-captcha", async (req, res) => {
  const { lat, lon } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: "lat and lon required" });

  console.log(`\n=== Get Captcha: ${lat}, ${lon} ===`);

  try {
    // Get village from GPS
    const geo = await reverseGeocode(lat, lon);
    console.log("Location:", geo.village, geo.district);

    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": "te-IN,te;q=0.9,en-US;q=0.8,en;q=0.7",
      "Connection": "keep-alive",
    };

    // Load MeeBhoomi page
    console.log("Loading MeeBhoomi...");
    const page1 = await axios.get("https://meebhoomi.ap.gov.in/Adangal.aspx", {
      headers, timeout: 20000
    });
    const cookies = page1.headers["set-cookie"]?.map(c => c.split(";")[0]).join("; ") || "";
    const $ = cheerio.load(page1.data);

    const vs = $("#__VIEWSTATE").val() || "";
    const evv = $("#__EVENTVALIDATION").val() || "";
    const vsg = $("#__VIEWSTATEGENERATOR").val() || "";

    if (!vs) {
      return res.json({ success: false, message: "MeeBhoomi not loading. Try again." });
    }

    // Get district options
    const distOpts = [];
    $("#ctl00_ContentPlaceHolder1_DropDownList1 option").each((i, el) => {
      const v = $(el).val();
      const t = $(el).text().trim();
      if (v) distOpts.push({ v, t });
    });
    console.log("Districts:", distOpts.length);

    // Match district
    const distMatch = distOpts.find(o =>
      o.t.toLowerCase().includes(geo.district.toLowerCase().split(" ")[0]) ||
      geo.district.toLowerCase().includes(o.t.toLowerCase().split(" ")[0])
    );
    if (!distMatch) {
      return res.json({ success: false, message: `District "${geo.district}" not found in MeeBhoomi. Try manual search.`, location: geo });
    }
    console.log("District:", distMatch.t);

    // Select district
    const page2 = await axios.post("https://meebhoomi.ap.gov.in/Adangal.aspx",
      new URLSearchParams({
        "__EVENTTARGET": "ctl00$ContentPlaceHolder1$DropDownList1",
        "__EVENTARGUMENT": "",
        "__VIEWSTATE": vs, "__VIEWSTATEGENERATOR": vsg, "__EVENTVALIDATION": evv,
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
      const v = $2(el).val();
      const t = $2(el).text().trim();
      if (v) mandalOpts.push({ v, t });
    });
    console.log("Mandals:", mandalOpts.length);

    const mandalMatch = mandalOpts.find(o =>
      o.t.toLowerCase().includes(geo.mandal.toLowerCase().split(" ")[0]) ||
      geo.mandal.toLowerCase().includes(o.t.toLowerCase().split(" ")[0])
    ) || mandalOpts[0];

    if (!mandalMatch) {
      return res.json({ success: false, message: `Mandal "${geo.mandal}" not found.`, location: geo });
    }
    console.log("Mandal:", mandalMatch.t);

    // Select mandal
    const page3 = await axios.post("https://meebhoomi.ap.gov.in/Adangal.aspx",
      new URLSearchParams({
        "__EVENTTARGET": "ctl00$ContentPlaceHolder1$DropDownList2",
        "__EVENTARGUMENT": "",
        "__VIEWSTATE": vs2, "__VIEWSTATEGENERATOR": vsg, "__EVENTVALIDATION": evv2,
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
      const v = $3(el).val();
      const t = $3(el).text().trim();
      if (v) villageOpts.push({ v, t });
    });
    console.log("Villages:", villageOpts.length);

    const villageMatch = villageOpts.find(o =>
      o.t.toLowerCase().includes(geo.village.toLowerCase().split(" ")[0]) ||
      geo.village.toLowerCase().includes(o.t.toLowerCase().split(" ")[0])
    ) || villageOpts[0];

    if (!villageMatch) {
      return res.json({ success: false, message: `Village "${geo.village}" not found.`, location: geo });
    }
    console.log("Village:", villageMatch.t);

    // Select village
    const page4 = await axios.post("https://meebhoomi.ap.gov.in/Adangal.aspx",
      new URLSearchParams({
        "__EVENTTARGET": "ctl00$ContentPlaceHolder1$DropDownList3",
        "__EVENTARGUMENT": "",
        "__VIEWSTATE": vs3, "__VIEWSTATEGENERATOR": vsg, "__EVENTVALIDATION": evv3,
        "ctl00$ContentPlaceHolder1$DropDownList1": distMatch.v,
        "ctl00$ContentPlaceHolder1$DropDownList2": mandalMatch.v,
        "ctl00$ContentPlaceHolder1$DropDownList3": villageMatch.v,
      }).toString(),
      { headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded", "Cookie": cookies, "Referer": "https://meebhoomi.ap.gov.in/Adangal.aspx" }, timeout: 20000 }
    );

    const $4 = cheerio.load(page4.data);
    const vs4 = $4("#__VIEWSTATE").val() || vs3;
    const evv4 = $4("#__EVENTVALIDATION").val() || evv3;

    // Get captcha image
    let captchaBase64 = "";
    const captchaImgSrc = $4("img[id*='aptcha'], img[id*='Captcha'], img[id*='CAPTCHA']").attr("src") || "";
    console.log("Captcha src:", captchaImgSrc);

    if (captchaImgSrc) {
      const captchaUrl = captchaImgSrc.startsWith("http") ? captchaImgSrc :
        `https://meebhoomi.ap.gov.in/${captchaImgSrc.replace(/^\//, "")}`;
      try {
        const imgRes = await axios.get(captchaUrl, {
          responseType: "arraybuffer",
          headers: { ...headers, "Cookie": cookies, "Referer": "https://meebhoomi.ap.gov.in/Adangal.aspx" },
          timeout: 10000
        });
        captchaBase64 = Buffer.from(imgRes.data).toString("base64");
        console.log("Captcha image downloaded, size:", captchaBase64.length);
      } catch(e) {
        console.log("Captcha image download failed:", e.message);
      }
    }

    // Save session
    const sessionId = Date.now().toString();
    sessions[sessionId] = {
      cookies, vs: vs4, evv: evv4, vsg,
      distVal: distMatch.v, mandalVal: mandalMatch.v, villageVal: villageMatch.v,
      distName: distMatch.t, mandalName: mandalMatch.t, villageName: villageMatch.t,
      location: geo, created: Date.now()
    };

    // Clean old sessions
    Object.keys(sessions).forEach(k => {
      if (Date.now() - sessions[k].created > 300000) delete sessions[k];
    });

    res.json({
      success: true,
      sessionId,
      captchaImage: captchaBase64 ? `data:image/png;base64,${captchaBase64}` : "",
      location: geo,
      detected: {
        district: distMatch.t,
        mandal: mandalMatch.t,
        village: villageMatch.t
      },
      message: captchaBase64 ? "Captcha ready! Enter the code shown." : "No captcha found — try submitting directly."
    });

  } catch(e) {
    console.error("get-captcha error:", e.message);
    res.json({ success: false, message: `Error: ${e.message}` });
  }
});

// ── STEP 2: Submit captcha → Get real data ─────────────────
app.post("/submit-captcha", async (req, res) => {
  const { sessionId, captcha } = req.body;
  if (!sessionId || !captcha) return res.status(400).json({ error: "sessionId and captcha required" });

  const session = sessions[sessionId];
  if (!session) return res.status(400).json({ error: "Session expired. Please try again." });

  console.log(`\n=== Submit Captcha: ${captcha} ===`);

  try {
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
      "Content-Type": "application/x-www-form-urlencoded",
      "Cookie": session.cookies,
      "Referer": "https://meebhoomi.ap.gov.in/Adangal.aspx"
    };

    // Submit form
    const result = await axios.post("https://meebhoomi.ap.gov.in/Adangal.aspx",
      new URLSearchParams({
        "__EVENTTARGET": "",
        "__EVENTARGUMENT": "",
        "__VIEWSTATE": session.vs,
        "__VIEWSTATEGENERATOR": session.vsg,
        "__EVENTVALIDATION": session.evv,
        "ctl00$ContentPlaceHolder1$DropDownList1": session.distVal,
        "ctl00$ContentPlaceHolder1$DropDownList2": session.mandalVal,
        "ctl00$ContentPlaceHolder1$DropDownList3": session.villageVal,
        "ctl00$ContentPlaceHolder1$RadioButtonList1": "2",
        "ctl00$ContentPlaceHolder1$TextBox1": captcha,
        "ctl00$ContentPlaceHolder1$Button1": "Click",
      }).toString(),
      { headers, timeout: 25000 }
    );

    const $ = cheerio.load(result.data);

    // Check for wrong captcha
    const errorMsg = $("span[id*='Label'], .error, #error").text().toLowerCase();
    if (errorMsg.includes("wrong") || errorMsg.includes("invalid") || errorMsg.includes("incorrect")) {
      return res.json({ success: false, message: "Wrong captcha! Please try again.", wrongCaptcha: true });
    }

    // Extract plots
    const plots = [];
    $("table tr").each((i, row) => {
      if (i === 0) return;
      const cells = $(row).find("td");
      if (cells.length >= 2) {
        const survey = $(cells[0]).text().trim();
        const owner = $(cells[1]).text().trim();
        const extent = $(cells[2]).text().trim() || $(cells[3]).text().trim();
        const landType = $(cells[4]).text().trim() || "Agricultural";
        if (survey && owner && survey.length > 1 && owner.length > 1 &&
            !survey.toLowerCase().includes("survey") && !owner.toLowerCase().includes("owner")) {
          plots.push({ surveyNumber:survey, ownerName:owner, extent:extent||"—", landType,
            village:session.villageName, mandal:session.mandalName, district:session.distName,
            lat:session.location.lat, lon:session.location.lon });
        }
      }
    });

    console.log("Real plots found:", plots.length);
    delete sessions[sessionId];

    if (plots.length > 0) {
      res.json({ success: true, source: "meebhoomi_live", plots,
        message: `✅ ${plots.length} real plots from MeeBhoomi!` });
    } else {
      res.json({ success: false, message: "No plots found. Captcha may be wrong or village has no records.", plots: [] });
    }

  } catch(e) {
    console.error("submit-captcha error:", e.message);
    res.json({ success: false, message: `Submission error: ${e.message}` });
  }
});

app.get("/health", (req, res) => res.json({ status:"ok", mode:"SEMI-AUTO — User solves captcha!" }));
app.get("/", (req, res) => res.json({ name:"LandCheck MeeBhoomi Semi-Auto v4" }));

app.listen(PORT, () => console.log(`✅ LandCheck on port ${PORT} — Semi-Auto Mode!`));

// ── STEP 3: Get full individual Adangal by survey number ───
app.get("/get-adangal-captcha", async (req, res) => {
  const { district, mandal, village, surveyNo } = req.query;
  if (!district || !village || !surveyNo) return res.status(400).json({ error: "district, village, surveyNo required" });

  console.log(`\n=== Get Adangal Captcha: ${surveyNo} in ${village} ===`);

  try {
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "te-IN,te;q=0.9,en-US;q=0.8",
      "Connection": "keep-alive",
    };

    // Load MeeBhoomi Adangal page
    const page1 = await axios.get("https://meebhoomi.ap.gov.in/Adangal.aspx", { headers, timeout: 20000 });
    const cookies = page1.headers["set-cookie"]?.map(c => c.split(";")[0]).join("; ") || "";
    const $ = cheerio.load(page1.data);

    const vs = $("#__VIEWSTATE").val() || "";
    const evv = $("#__EVENTVALIDATION").val() || "";
    const vsg = $("#__VIEWSTATEGENERATOR").val() || "";
    if (!vs) return res.json({ success: false, message: "MeeBhoomi not loading" });

    // Match and select district
    const distOpts = [];
    $("#ctl00_ContentPlaceHolder1_DropDownList1 option").each((i, el) => {
      const v = $(el).val(); const t = $(el).text().trim();
      if (v) distOpts.push({ v, t });
    });
    const distMatch = distOpts.find(o =>
      o.t.toLowerCase().includes(district.toLowerCase().split(" ")[0]) ||
      district.toLowerCase().includes(o.t.toLowerCase().split(" ")[0])
    );
    if (!distMatch) return res.json({ success: false, message: `District ${district} not found` });

    const page2 = await axios.post("https://meebhoomi.ap.gov.in/Adangal.aspx",
      new URLSearchParams({ "__EVENTTARGET": "ctl00$ContentPlaceHolder1$DropDownList1", "__EVENTARGUMENT": "", "__VIEWSTATE": vs, "__VIEWSTATEGENERATOR": vsg, "__EVENTVALIDATION": evv, "ctl00$ContentPlaceHolder1$DropDownList1": distMatch.v, "ctl00$ContentPlaceHolder1$DropDownList2": "", "ctl00$ContentPlaceHolder1$DropDownList3": "" }).toString(),
      { headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded", "Cookie": cookies, "Referer": "https://meebhoomi.ap.gov.in/Adangal.aspx" }, timeout: 20000 }
    );

    const $2 = cheerio.load(page2.data);
    const vs2 = $2("#__VIEWSTATE").val() || vs;
    const evv2 = $2("#__EVENTVALIDATION").val() || evv;

    const mandalOpts = [];
    $2("#ctl00_ContentPlaceHolder1_DropDownList2 option").each((i, el) => { const v=$2(el).val(); const t=$2(el).text().trim(); if(v) mandalOpts.push({v,t}); });
    const mandalMatch = mandalOpts.find(o => o.t.toLowerCase().includes(mandal.toLowerCase().split(" ")[0])) || mandalOpts[0];

    const page3 = await axios.post("https://meebhoomi.ap.gov.in/Adangal.aspx",
      new URLSearchParams({ "__EVENTTARGET": "ctl00$ContentPlaceHolder1$DropDownList2", "__EVENTARGUMENT": "", "__VIEWSTATE": vs2, "__VIEWSTATEGENERATOR": vsg, "__EVENTVALIDATION": evv2, "ctl00$ContentPlaceHolder1$DropDownList1": distMatch.v, "ctl00$ContentPlaceHolder1$DropDownList2": mandalMatch.v, "ctl00$ContentPlaceHolder1$DropDownList3": "" }).toString(),
      { headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded", "Cookie": cookies, "Referer": "https://meebhoomi.ap.gov.in/Adangal.aspx" }, timeout: 20000 }
    );

    const $3 = cheerio.load(page3.data);
    const vs3 = $3("#__VIEWSTATE").val() || vs2;
    const evv3 = $3("#__EVENTVALIDATION").val() || evv2;

    const villageOpts = [];
    $3("#ctl00_ContentPlaceHolder1_DropDownList3 option").each((i, el) => { const v=$3(el).val(); const t=$3(el).text().trim(); if(v) villageOpts.push({v,t}); });
    const villageMatch = villageOpts.find(o => o.t.toLowerCase().includes(village.toLowerCase().split(" ")[0])) || villageOpts[0];

    const page4 = await axios.post("https://meebhoomi.ap.gov.in/Adangal.aspx",
      new URLSearchParams({ "__EVENTTARGET": "ctl00$ContentPlaceHolder1$DropDownList3", "__EVENTARGUMENT": "", "__VIEWSTATE": vs3, "__VIEWSTATEGENERATOR": vsg, "__EVENTVALIDATION": evv3, "ctl00$ContentPlaceHolder1$DropDownList1": distMatch.v, "ctl00$ContentPlaceHolder1$DropDownList2": mandalMatch.v, "ctl00$ContentPlaceHolder1$DropDownList3": villageMatch.v }).toString(),
      { headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded", "Cookie": cookies, "Referer": "https://meebhoomi.ap.gov.in/Adangal.aspx" }, timeout: 20000 }
    );

    const $4 = cheerio.load(page4.data);
    const vs4 = $4("#__VIEWSTATE").val() || vs3;
    const evv4 = $4("#__EVENTVALIDATION").val() || evv3;

    // Get captcha
    let captchaBase64 = "";
    const captchaImgSrc = $4("img[id*='aptcha'], img[id*='Captcha']").attr("src") || "";
    if (captchaImgSrc) {
      const captchaUrl = captchaImgSrc.startsWith("http") ? captchaImgSrc : `https://meebhoomi.ap.gov.in/${captchaImgSrc.replace(/^\//, "")}`;
      try {
        const imgRes = await axios.get(captchaUrl, { responseType: "arraybuffer", headers: { ...headers, "Cookie": cookies }, timeout: 10000 });
        captchaBase64 = Buffer.from(imgRes.data).toString("base64");
      } catch(e) { console.log("Captcha img error:", e.message); }
    }

    const sessionId = "adangal_" + Date.now().toString();
    sessions[sessionId] = {
      cookies, vs: vs4, evv: evv4, vsg,
      distVal: distMatch.v, mandalVal: mandalMatch.v, villageVal: villageMatch.v,
      distName: distMatch.t, mandalName: mandalMatch.t, villageName: villageMatch.t,
      surveyNo, created: Date.now()
    };

    res.json({
      success: true, sessionId,
      captchaImage: captchaBase64 ? `data:image/png;base64,${captchaBase64}` : "",
      message: "Enter captcha to get full land details!"
    });

  } catch(e) {
    console.error("adangal-captcha error:", e.message);
    res.json({ success: false, message: e.message });
  }
});

// ── STEP 4: Submit adangal captcha → get full details ──────
app.post("/submit-adangal", async (req, res) => {
  const { sessionId, captcha } = req.body;
  const session = sessions[sessionId];
  if (!session) return res.status(400).json({ error: "Session expired" });

  console.log(`\n=== Submit Adangal: ${captcha} for survey ${session.surveyNo} ===`);

  try {
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
      "Content-Type": "application/x-www-form-urlencoded",
      "Cookie": session.cookies,
      "Referer": "https://meebhoomi.ap.gov.in/Adangal.aspx"
    };

    const result = await axios.post("https://meebhoomi.ap.gov.in/Adangal.aspx",
      new URLSearchParams({
        "__EVENTTARGET": "", "__EVENTARGUMENT": "",
        "__VIEWSTATE": session.vs, "__VIEWSTATEGENERATOR": session.vsg, "__EVENTVALIDATION": session.evv,
        "ctl00$ContentPlaceHolder1$DropDownList1": session.distVal,
        "ctl00$ContentPlaceHolder1$DropDownList2": session.mandalVal,
        "ctl00$ContentPlaceHolder1$DropDownList3": session.villageVal,
        "ctl00$ContentPlaceHolder1$RadioButtonList1": "1", // One survey number
        "ctl00$ContentPlaceHolder1$TextBox1": session.surveyNo,
        "ctl00$ContentPlaceHolder1$TextBox2": captcha,
        "ctl00$ContentPlaceHolder1$Button1": "Click",
      }).toString(),
      { headers, timeout: 25000 }
    );

    const $ = cheerio.load(result.data);

    // Extract ALL details from adangal
    const details = {};
    $("table tr").each((i, row) => {
      const cells = $(row).find("td");
      if (cells.length >= 2) {
        const key = $(cells[0]).text().trim().toLowerCase();
        const val = $(cells[1]).text().trim();
        if (key && val) details[key] = val;
      }
    });

    console.log("Adangal details found:", Object.keys(details).length, details);

    // Map to our fields
    const fullData = {
      ownerName: details["pattadar name"] || details["owner name"] || details["పట్టాదారు పేరు"] || "",
      surveyNumber: session.surveyNo,
      extent: details["extent"] || details["area"] || details["విస్తీర్ణం"] || "",
      landType: details["land type"] || details["nature of land"] || "Agricultural",
      soilType: details["soil type"] || details["నేల రకం"] || details["soil"] || "—",
      waterSource: details["water source"] || details["నీటి వనరు"] || details["irrigation"] || "—",
      cropGrown: details["crop"] || details["పంట"] || details["crop grown"] || "—",
      khataNumber: details["khata no"] || details["account no"] || "—",
      pattadarNumber: details["pattadar no"] || "—",
      village: session.villageName,
      mandal: session.mandalName,
      district: session.distName,
      source: "meebhoomi_live",
      rawData: details
    };

    delete sessions[sessionId];

    if (Object.keys(details).length > 0) {
      res.json({ success: true, data: fullData, message: "✅ Real full Adangal data!" });
    } else {
      res.json({ success: false, message: "Wrong captcha or no data found.", wrongCaptcha: true });
    }

  } catch(e) {
    console.error("submit-adangal error:", e.message);
    res.json({ success: false, message: e.message });
  }
});
