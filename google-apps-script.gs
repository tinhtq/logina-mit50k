/**
 * LOGINA — Waitlist signups → Google Sheet
 * -----------------------------------------
 * This script is now called by the Cloudflare Worker (not the browser directly).
 * The Worker attaches a SHARED_SECRET that this script verifies, so random POSTs
 * to the Web App URL are rejected.
 *
 * One-time setup (see README.md "Google Sheet integration" + cloudflare-worker/README.md):
 *   1. Create a Google Sheet. Extensions → Apps Script.
 *   2. Paste this file's content, Save.
 *   3. Set the shared secret: Project Settings → Script properties →
 *        add property  SHARED_SECRET  = <same long random string used in the Worker>.
 *   4. Deploy → New deployment → type "Web app".
 *        - Execute as: Me
 *        - Who has access: Anyone
 *      Copy the Web App URL (ends with /exec) → set it as the Worker's APPS_SCRIPT_URL secret.
 *
 * Each submission becomes one row, with a server-side timestamp.
 * Only the sheet owner (and people they share with) can read the data.
 */

// Optional: lock to a specific sheet tab name. Leave "" to use the first sheet.
var SHEET_NAME = '';

// Header row written automatically on first run.
var HEADERS = ['Timestamp', 'Name', 'Email', 'Role', 'Organization', 'Context', 'Consent', 'Source', 'Submitted At (client)'];

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000); // avoid race conditions on concurrent signups
  try {
    var data = JSON.parse(e.postData.contents);

    // Require the shared secret set by the Cloudflare Worker.
    var expected = PropertiesService.getScriptProperties().getProperty('SHARED_SECRET');
    if (!expected || String(data.secret) !== expected) {
      return json_({ ok: false, error: 'Unauthorized.' });
    }

    // Server-side validation of required fields.
    if (!data.name || !data.email || !data.role || data.consent !== true) {
      return json_({ ok: false, error: 'Missing required fields.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(data.email))) {
      return json_({ ok: false, error: 'Invalid email.' });
    }

    var sheet = getSheet_();
    ensureHeaders_(sheet);

    // De-dupe by email (optional): skip if email already present in column 3.
    var emailLower = String(data.email).trim().toLowerCase();
    var lastRow = sheet.getLastRow();
    if (lastRow >= 2) { // only check when at least one data row exists (row 1 = headers)
      var existing = sheet.getRange(2, 3, lastRow - 1, 1).getValues();
      for (var i = 0; i < existing.length; i++) {
        if (String(existing[i][0]).trim().toLowerCase() === emailLower) {
          return json_({ ok: true, duplicate: true });
        }
      }
    }

    sheet.appendRow([
      new Date(),
      String(data.name).slice(0, 200),
      String(data.email).slice(0, 200),
      String(data.role).slice(0, 100),
      String(data.organization || '').slice(0, 200),
      String(data.context || '').slice(0, 1000),
      data.consent === true ? 'YES' : 'NO',
      String(data.source || '').slice(0, 120),
      String(data.submittedAt || '')
    ]);

    return json_({ ok: true });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

// Simple health check when opened in a browser.
function doGet() {
  return json_({ ok: true, service: 'LOGINA waitlist' });
}

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (SHEET_NAME) {
    return ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  }
  return ss.getSheets()[0];
}

function ensureHeaders_(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
