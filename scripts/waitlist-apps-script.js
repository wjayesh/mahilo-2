// Google Apps Script — deploy as Web App
// Spreadsheet: "Mahilo Waitlist" (1wXLidVxftDW5jojvFjIU8W-i6moh_NdV9dNjQD3l2d8)
//
// Steps to deploy:
// 1. Go to https://script.google.com
// 2. Create new project, paste this code
// 3. Deploy → New deployment → Web app
//    - Execute as: Me
//    - Who has access: Anyone
// 4. Copy the web app URL and put it in the frontend

const SPREADSHEET_ID = '1wXLidVxftDW5jojvFjIU8W-i6moh_NdV9dNjQD3l2d8';
const SHEET_NAME = 'Sheet1';

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const email = (data.email || '').trim().toLowerCase();
    
    if (!email || !email.includes('@')) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        error: 'Invalid email'
      })).setMimeType(ContentService.MimeType.JSON);
    }

    const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEET_NAME);
    
    // Check for duplicates
    const emails = sheet.getRange('A:A').getValues().flat().map(e => e.toString().toLowerCase());
    if (emails.includes(email)) {
      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        message: 'Already on the waitlist'
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // Append row
    sheet.appendRow([email, data.source || 'landing', new Date().toISOString()]);

    return ContentService.createTextOutput(JSON.stringify({
      success: true,
      message: 'Added to waitlist'
    })).setMimeType(ContentService.MimeType.JSON);
    
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      error: err.message
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

// For testing via GET
function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({
    status: 'ok',
    message: 'Mahilo Waitlist API'
  })).setMimeType(ContentService.MimeType.JSON);
}
