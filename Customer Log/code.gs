// ---------- CONFIG ----------
const DEPT_SHEET      = 'Departments';
const EMP_SHEET       = 'Employees';
const SHIFT_SHEET     = 'Shifts';

const ROSTER_SHEET    = 'Roster';     // single sheet to store roster rows + pdf metadata
const DRIVE_FOLDER_NAME = 'Duty Roster Published PDFs';


// ---------- ENTRY ----------
function doGet() {
  return HtmlService.createTemplateFromFile('index').evaluate()
    .setTitle('Duty Roster')
    .addMetaTag('viewport','width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}


// ---------- HELPERS ----------
function sheet(name) {
  const ss = SpreadsheetApp.getActive();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function slugify(s) {
  if (!s) return '';
  return String(s).trim()
    .toLowerCase()
    .replace(/[\s\|\/:,]+/g, '-')
    .replace(/[^a-z0-9\-]/g, '')
    .replace(/\-+/g, '-')
    .replace(/^\-+|\-+$/g, '')
    .toUpperCase();
}

function iso(d) {
  return Utilities.formatDate(new Date(d), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function mondayOf(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = (day === 0) ? -6 : (1 - day);
  d.setDate(d.getDate() + diff);
  d.setHours(0,0,0,0);
  return d;
}

function getOrCreateFolder(name) {
  const it = DriveApp.getFoldersByName(name);
  if (it.hasNext()) return it.next();
  return DriveApp.createFolder(name);
}

/**
 * Ensure Roster sheet has headers for:
 * Timestamp, WeekStart, Department, Employee Name, Employee ID, Role, Default Shift, Weekly Off,
 * Mon, Tue, Wed, Thu, Fri, Sat, Sun, PDF File Name, PDF File Id, PDF URL
 */
function ensureHeadersRosterSheet() {
  const sh = sheet(ROSTER_SHEET);
  const headers = [
    'Timestamp',
    'WeekStart',
    'Department',
    'Employee Name',
    'Employee ID',
    'Role',
    'Default Shift',
    'Weekly Off',
    'Mon',
    'Tue',
    'Wed',
    'Thu',
    'Fri',
    'Sat',
    'Sun',
    'PDF File Name',
    'PDF File Id',
    'PDF URL'
  ];

  // if sheet empty, write headers
  if (sh.getLastRow() === 0) {
    sh.getRange(1,1,1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
    return;
  }

  // if first row all empty or doesn't match, set headers (safe)
  const firstRow = sh.getRange(1,1,1, headers.length).getValues()[0];
  const allEmpty = firstRow.every(v => v === '' || v === null);
  if (allEmpty || firstRow[0] !== headers[0]) {
    sh.getRange(1,1,1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
  }
}


// ---------- DEPARTMENTS ----------
function getDepartments() {
  const sh = sheet(DEPT_SHEET);
  const values = sh.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const v = values[i][0];
    if (v && String(v).trim()) out.push({ id: String(v).trim(), name: String(v).trim() });
  }
  return out;
}


// ---------- SHIFTS ----------
function getShifts() {
  const sh = sheet(SHIFT_SHEET);
  const values = sh.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const raw = values[i][0];
    if (raw && String(raw).trim()) {
      const name = String(raw).trim();
      const id = slugify(name) || name;
      out.push({ id, name });
    }
  }
  // ensure OFF exists
  if (!out.find(s => s.id === 'OFF')) out.push({ id: 'OFF', name: 'Off' });
  return out;
}


// ---------- EMPLOYEES ----------
/*
 Expected Employees sheet columns (0-index):
 [ 0: department, 1: name, 2: role, 3: defaultShift (name or id), 4: weeklyOff (Mon/Tue...), 5: empId? ]
*/
function getEmployeesForDepartment(department) {
  const empSh = sheet(EMP_SHEET);
  const empVals = empSh.getDataRange().getValues();
  const shifts = getShifts();
  const nameToId = {};
  shifts.forEach(s => { nameToId[s.name] = s.id; nameToId[String(s.name).toLowerCase()] = s.id; });

  const out = [];
  for (let i = 1; i < empVals.length; i++) {
    const row = empVals[i];
    const dept = String(row[0] || '').trim();
    if (!dept || String(dept) !== String(department)) continue;

    const name = String(row[1] || '').trim();
    if (!name) continue;

    const role = String(row[2] || '').trim();
    const defaultShiftRaw = String(row[3] || '').trim();
    const weeklyOffRaw = String(row[4] || '').trim();
    const empId = String(row[5] || name).trim();

    // canonicalize weekly off to 'Mon','Tue',...
    const days = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
    let weeklyOffShort = '';
    if (weeklyOffRaw) {
      const found = days.find(d => d.toLowerCase() === weeklyOffRaw.slice(0,3).toLowerCase());
      if (found) weeklyOffShort = found;
    }

    // map default shift raw (name) to id when possible
    let defaultShiftId = '';
    if (defaultShiftRaw) {
      defaultShiftId = nameToId[defaultShiftRaw] || nameToId[defaultShiftRaw.toLowerCase()] || slugify(defaultShiftRaw);
    }

    out.push({
      empName: name,
      empId: empId,
      role: role,
      defaultShift: defaultShiftId,
      weeklyOff: weeklyOffShort
    });
  }
  return out;
}


// ---------- PUBLISH ROSTER (ALL IN 'Roster' SHEET) ----------
/**
 * Frontend call:
 * publishRoster({ weekStartIso, department, rows, pdfBase64 })
 *
 * rows = [
 *   {
 *     timestamp,
 *     weekStartIso,
 *     department,
 *     empName,
 *     empId,
 *     role,
 *     defaultShiftName,
 *     weeklyOff,
 *     dayMon, dayTue, dayWed, dayThu, dayFri, daySat, daySun
 *   }
 * ]
 *
 * Behavior:
 * - create PDF file in Drive folder
 * - set sharing to anyone with link view
 * - delete existing rows in Roster sheet for same week+department
 * - write one row per employee with PDF metadata appended
 * - return { success:true, url, fileId }
 */
function publishRoster(payload) {
  try {
    if (!payload) throw new Error('No payload received');

    const weekStartIso = String(payload.weekStartIso || '').trim();
    const department = String(payload.department || '').trim();
    const rows = payload.rows || [];
    const pdfBase64 = payload.pdfBase64 || '';

    if (!weekStartIso) throw new Error('weekStartIso missing');
    if (!department) throw new Error('department missing');
    if (!rows.length) throw new Error('rows empty');
    if (!pdfBase64) throw new Error('pdfBase64 missing');

    // normalize week start (force Monday)
    const monday = mondayOf(weekStartIso);
    const normalizedWeekIso = iso(monday);

    // 1) Create PDF file first (so we can include metadata in rows)
    const folder = getOrCreateFolder(DRIVE_FOLDER_NAME);

    const safeDept = department.replace(/[^\w\s\-]/g, '').trim().replace(/\s+/g, '_') || 'dept';
    const fileName = `${safeDept}_DutyRoster_${normalizedWeekIso}.pdf`;

    // decode base64 and create blob
    const bytes = Utilities.base64Decode(pdfBase64);
    const blob = Utilities.newBlob(bytes, 'application/pdf', fileName);

    const file = folder.createFile(blob);
    if (!file) throw new Error('PDF file creation failed');

    // make the file viewable (anyone with link)
    try {
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (e) {
      // if setSharing fails due to domain restrictions, ignore but still continue
      console.warn('setSharing failed:', e && e.message);
    }

    const fileId = file.getId();
    const pdfUrl = `https://drive.google.com/file/d/${fileId}/view`;

    // 2) Ensure headers then delete existing rows for same week+dept
    ensureHeadersRosterSheet();
    const rosterSh = sheet(ROSTER_SHEET);
    deleteExistingRosterForWeekDept_(normalizedWeekIso, department);

    // 3) Build and write rows (include pdf metadata in each row)
    const valuesToWrite = rows.map(r => ([
      new Date(),                        // Timestamp
      normalizedWeekIso,                 // WeekStart
      department,                        // Department
      String(r.empName || ''),           // Employee Name
      String(r.empId || ''),             // Employee ID
      String(r.role || ''),              // Role
      String(r.defaultShiftName || ''),  // Default Shift (NAME)
      String(r.weeklyOff || ''),         // Weekly Off
      String(r.dayMon || ''),            // Mon
      String(r.dayTue || ''),            // Tue
      String(r.dayWed || ''),            // Wed
      String(r.dayThu || ''),            // Thu
      String(r.dayFri || ''),            // Fri
      String(r.daySat || ''),            // Sat
      String(r.daySun || ''),            // Sun
      fileName,                          // PDF File Name
      fileId,                            // PDF File Id
      pdfUrl                             // PDF URL
    ]));

    // write in one batch
    rosterSh.getRange(rosterSh.getLastRow() + 1, 1, valuesToWrite.length, valuesToWrite[0].length)
      .setValues(valuesToWrite);

    return {
      success: true,
      url: pdfUrl,
      fileId: fileId
    };

  } catch (err) {
    console.error(err);
    return {
      success: false,
      message: err && err.message ? err.message : String(err)
    };
  }
}


/**
 * Delete existing rows in Roster sheet for given weekStartIso + department (so publish replaces)
 * Note: deletes rows from bottom to top to preserve indexes.
 */
function deleteExistingRosterForWeekDept_(weekStartIso, department) {
  const sh = sheet(ROSTER_SHEET);
  const data = sh.getDataRange().getValues();
  if (data.length <= 1) return; // nothing to delete (only header)

  // Header columns positions (1-based)
  // 1: Timestamp, 2: WeekStart, 3: Department
  const COL_WEEK = 2;
  const COL_DEPT = 3;

  const rowsToDelete = [];
  for (let i = 1; i < data.length; i++) {
    const week = String(data[i][COL_WEEK - 1] || '').trim();
    const dept = String(data[i][COL_DEPT - 1] || '').trim();
    if (week === weekStartIso && dept === department) rowsToDelete.push(i + 1);
  }
  // delete from bottom
  rowsToDelete.reverse().forEach(r => sh.deleteRow(r));
}


/**
 * Return the latest published PDF info (fileId + url) for given weekStartIso and department.
 * Scans the Roster sheet for rows matching week + department and returns the newest PDF info found.
 * Returns { success:true, fileId, url } or { success:false, message }
 */
function getPublishedPdfForWeek(params) {
  try {
    if (!params || !params.weekStartIso || !params.department) return { success: false, message: 'Missing params' };

    const weekStartIso = String(params.weekStartIso).trim();
    const department = String(params.department).trim();

    ensureHeadersRosterSheet();
    const sh = sheet(ROSTER_SHEET);
    const data = sh.getDataRange().getValues();
    if (data.length <= 1) return { success:false, message: 'No published rows' };

    // columns: PDF File Name at index 16 (1-based) -> zero-index 15
    const COL_PDF_NAME = 16;
    const COL_PDF_ID   = 17;
    const COL_PDF_URL  = 18;

    const COL_WEEK = 2;
    const COL_DEPT = 3;

    // find last matching row with non-empty pdf id/url
    let found = null;
    for (let i = data.length - 1; i >= 1; i--) {
      const row = data[i];
      const week = String(row[COL_WEEK - 1] || '').trim();
      const dept = String(row[COL_DEPT - 1] || '').trim();
      const fileId = String(row[COL_PDF_ID - 1] || '').trim();
      const url = String(row[COL_PDF_URL - 1] || '').trim();
      if (week === weekStartIso && dept === department && fileId) {
        found = { fileId, url };
        break;
      }
    }

    if (!found) return { success:false, message: 'No published PDF found for this week+department' };
    return { success:true, fileId: found.fileId, url: found.url };

  } catch (err) {
    console.error(err);
    return { success:false, message: err && err.message ? err.message : String(err) };
  }
}
























// ---------- LOAD ROSTER ----------
/*
 Returns:
 {
   weekStartIso: 'YYYY-MM-DD',
   department: 'DeptName',
   shifts: [{id,name},...],
   employees: [
     { empName, empId?, role, defaultShift (id), weeklyOff (short), days:[{date,shiftId}, ...] }
   ]
 }
*/
// function getRosterForWeek({ weekStartIso, department }) {
//   // normalize
//   const weekStart = mondayOf(weekStartIso);
//   const rosterSh = sheet(ROSTER_SHEET);
//   const empSh = sheet(EMP_SHEET);

//   const shifts = getShifts();
//   const maps = buildShiftMaps(shifts);

//   // Read current roster data (sheet stores *names* in shift column)
//   const rosterData = rosterSh.getDataRange().getValues();
//   const existingIndex = {};

//   for (let i = 1; i < rosterData.length; i++) {
//     const r = rosterData[i];
//     // key: week|dept|name|date
//     const key = `${r[0]}|${r[1]}|${r[2]}|${r[3]}`;
//     existingIndex[key] = true;
//   }

//   // load employees for department
//   const empData = empSh.getDataRange().getValues();
//   const employees = [];

//   // expected Employees columns: [ department, name, role, defaultShift, weeklyOff, empId? ]
//   for (let i = 1; i < empData.length; i++) {
//     if (String(empData[i][0] || '').trim() !== String(department || '').trim()) continue;

//     const name = String(empData[i][1] || '').trim();
//     const role = String(empData[i][2] || '').trim();
//     const defaultShiftRaw = String(empData[i][3] || '').trim(); // could be name
//     const weeklyOffRaw = String(empData[i][4] || '').trim();
//     const empId = String(empData[i][5] || name).trim();

//     // canonicalize weekly off to 3-letter
//     const days = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
//     let weeklyOffShort = '';
//     if (weeklyOffRaw) {
//       const found = days.find(d => d.toLowerCase() === weeklyOffRaw.slice(0,3).toLowerCase());
//       if (found) weeklyOffShort = found;
//     }

//     // map defaultShift to id if possible
//     let defaultShiftId = '';
//     if (defaultShiftRaw) {
//       if (maps.nameToId[defaultShiftRaw]) defaultShiftId = maps.nameToId[defaultShiftRaw];
//       else if (maps.nameToId[defaultShiftRaw.toLowerCase()]) defaultShiftId = maps.nameToId[defaultShiftRaw.toLowerCase()];
//       else defaultShiftId = slugify(defaultShiftRaw);
//     }

//     employees.push({
//       empName: name,
//       role: role,
//       defaultShift: defaultShiftId,
//       weeklyOff: weeklyOffShort,
//       empId
//     });
//   }

//   // prepare rows to ensure roster exists for the week (insert missing rows using *names*)
//   const rowsToInsert = [];
//   const outputEmployees = [];

//   employees.forEach(emp => {
//     const daysArr = [];
//     for (let i = 0; i < 7; i++) {
//       const date = addDays(weekStart, i);
//       const dateIso = iso(date);
//       const dayName = date.toLocaleDateString('en-US', { weekday: 'short' }); // Mon, Tue, ...
//       const isOff = String(emp.weeklyOff || '').slice(0,3).toLowerCase() === dayName.slice(0,3).toLowerCase();
//       const chosenId = isOff ? 'OFF' : (emp.defaultShift || (shifts[0] && shifts[0].id) || 'OFF');
//       const key = `${iso(weekStart)}|${department}|${emp.empName}|${dateIso}`;

//       // convert chosenId to human name to write into sheet
//       const shiftNameToWrite = maps.idToName[chosenId] || chosenId;

//       if (!existingIndex[key]) {
//         rowsToInsert.push([
//           iso(weekStart),
//           department,
//           emp.empName,
//           dateIso,
//           shiftNameToWrite,
//           'Draft',
//           new Date()
//         ]);
//         // mark as existing to avoid duplicate insertion in this run
//         existingIndex[key] = true;
//       }
//       daysArr.push({ date: dateIso, shiftId: chosenId });
//     }

//     outputEmployees.push({
//       empName: emp.empName,
//       empId: emp.empId,
//       role: emp.role,
//       defaultShift: emp.defaultShift,
//       weeklyOff: emp.weeklyOff,
//       days: daysArr
//     });
//   });

//   if (rowsToInsert.length) {
//     rosterSh.getRange(rosterSh.getLastRow() + 1, 1, rowsToInsert.length, rowsToInsert[0].length)
//       .setValues(rowsToInsert);
//   }

//   // refresh roster data after potential inserts and build mapping of actual stored shifts (sheet stores names)
//   const freshData = rosterSh.getDataRange().getValues();
//   const employeeMap = {}; // map empName -> {date: shiftId}
//   for (let i = 1; i < freshData.length; i++) {
//     const r = freshData[i];
//     if (r[0] === iso(weekStart) && r[1] === department) {
//       const name = r[2];
//       const date = r[3];
//       const storedShiftName = String(r[4] || '').trim();
//       // map stored shift name back to ID
//       const sid = maps.nameToId[storedShiftName] || maps.nameToId[storedShiftName.toLowerCase()] || (storedShiftName === 'Off' ? 'OFF' : slugify(storedShiftName));
//       if (!employeeMap[name]) employeeMap[name] = {};
//       employeeMap[name][date] = sid;
//     }
//   }

//   // merge actual stored shifts into outputEmployees
//   outputEmployees.forEach(emp => {
//     emp.days = emp.days.map(d => {
//       const actualShift = (employeeMap[emp.empName] && employeeMap[emp.empName][d.date]) || d.shiftId;
//       return { date: d.date, shiftId: actualShift };
//     });
//   });

//   return {
//     weekStartIso: iso(weekStart),
//     department,
//     shifts,
//     employees: outputEmployees
//   };
// }

























































// // ---------- SAVE / PUBLISH ----------
// function saveDraft({ weekStartIso, department, roster }) {
//   upsertRoster(weekStartIso, department, roster, 'Draft');
//   return true;
// }

// function publishRoster({ weekStartIso, department, roster, pdfBase64 }) {
//   // upsert roster rows and mark Published
//   upsertRoster(weekStartIso, department, roster, 'Published');

//   // if pdf present, save it and register in Published sheet
//   if (pdfBase64) {
//     const url = savePdfBase64ToDrive(weekStartIso, department, pdfBase64);
//     recordPublishedPdf(weekStartIso, department, url);
//     return { success: true, url };
//   }
//   return { success: true };
// }

// ---------- UPSERT CORE ----------
// function upsertRoster(weekStartIso, department, roster, status) {
//   const sh = sheet(ROSTER_SHEET);
//   const dataRange = sh.getDataRange();
//   const data = dataRange.getValues();
//   const rowIndex = {};

//   for (let i = 1; i < data.length; i++) {
//     const key = `${data[i][0]}|${data[i][1]}|${data[i][2]}|${data[i][3]}`;
//     rowIndex[key] = i + 1;
//   }

//   const shifts = getShifts();
//   const maps = buildShiftMaps(shifts);

//   const inserts = [];

//   roster.forEach(emp => {
//     const empName = emp.empName || emp.name || '';
//     emp.days.forEach(d => {
//       const key = `${weekStartIso}|${department}|${empName}|${d.date}`;

//       const writeShiftName = maps.idToName[d.shiftId] || d.shiftId;

//       const row = [
//         weekStartIso,
//         department,
//         empName,
//         d.date,
//         writeShiftName,
//         status,
//         new Date()
//       ];

//       if (rowIndex[key]) {
//         sh.getRange(rowIndex[key], 1, 1, row.length).setValues([row]);
//       } else {
//         inserts.push(row);
//         // add to rowIndex so subsequent duplicates in same payload don't duplicate
//         rowIndex[key] = (sh.getLastRow() + inserts.length);
//       }
//     });
//   });

//   if (inserts.length) {
//     sh.getRange(sh.getLastRow() + 1, 1, inserts.length, inserts[0].length)
//       .setValues(inserts);
//   }
// }

// ---------- COPY LAST WEEK ----------
// function copyLastWeek({ weekStartIso, department }) {
//   const prevWeek = iso(addDays(new Date(weekStartIso), -7));
//   const sh = sheet(ROSTER_SHEET);
//   const data = sh.getDataRange().getValues();
//   const existingKeys = {};

//   // build existing keys for target week to avoid duplicates
//   for (let i = 1; i < data.length; i++) {
//     const r = data[i];
//     if (r[0] === weekStartIso && r[1] === department) {
//       existingKeys[`${r[2]}|${r[3]}`] = true; // name|date
//     }
//   }

//   const rows = [];
//   for (let i = 1; i < data.length; i++) {
//     const r = data[i];
//     if (r[0] === prevWeek && r[1] === department) {
//       const newDate = iso(addDays(new Date(r[3]), 7));
//       const key = `${r[2]}|${newDate}`;
//       if (!existingKeys[key]) {
//         rows.push([
//           weekStartIso,
//           department,
//           r[2],
//           newDate,
//           r[4],      // shift name kept as-is (human)
//           'Draft',
//           new Date()
//         ]);
//         existingKeys[key] = true;
//       }
//     }
//   }

//   if (rows.length) {
//     sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length)
//       .setValues(rows);
//   }
//   return true;
// }

// ---------- PDF: save base64 to Drive ----------
// function savePdfBase64ToDrive(weekStartIso, department, base64) {
//   // base64 expected to be raw base64 (no data: prefix) from client
//   if (!base64) throw new Error('No PDF base64 provided');
//   const folder = getOrCreateFolder('Duty Roster PDFs');
//   const bytes = Utilities.base64Decode(base64);
//   const filename = `DutyRoster_${department.replace(/\s+/g,'_')}_${weekStartIso}.pdf`;
//   const blob = Utilities.newBlob(bytes, 'application/pdf', filename);
//   const file = folder.createFile(blob);
//   file.setDescription(`Duty roster for ${department} (${weekStartIso})`);
//   return file.getUrl();
// }

// // record published pdf in Published sheet (updates existing row if present)
// function recordPublishedPdf(weekStartIso, department, url) {
//   const sh = sheet(PUBLISHED_SHEET);
//   // ensure header
//   const header = ['WeekStartIso', 'Department', 'PdfUrl', 'PublishedOn'];
//   if (sh.getLastRow() === 0) sh.getRange(1,1,1,header.length).setValues([header]);

//   const data = sh.getDataRange().getValues();
//   let foundRow = null;
//   for (let i = 1; i < data.length; i++) {
//     if (data[i][0] === weekStartIso && data[i][1] === department) {
//       foundRow = i + 1;
//       break;
//     }
//   }
//   if (foundRow) {
//     sh.getRange(foundRow, 3, 1, 2).setValues([[url, new Date()]]);
//   } else {
//     sh.appendRow([weekStartIso, department, url, new Date()]);
//   }
// }

// // savePDF callable from client (separate from publishRoster)
// function savePDF({ weekStartIso, department, pdfBase64 }) {
//   const url = savePdfBase64ToDrive(weekStartIso, department, pdfBase64);
//   recordPublishedPdf(weekStartIso, department, url);
//   return url;
// }

// // optional: get the published PDF for a week/department
// function getPublishedPdfForWeek({ weekStartIso, department }) {
//   const sh = sheet(PUBLISHED_SHEET);
//   const data = sh.getDataRange().getValues();
//   for (let i = 1; i < data.length; i++) {
//     if (data[i][0] === weekStartIso && data[i][1] === department) {
//       return { url: data[i][2], publishedOn: data[i][3] };
//     }
//   }
//   return null;
// }

// // ---------- Old generatePDF preserved (still useful if you prefer server-built HTML -> PDF) ----------
// function generatePDF({ weekStartIso, department }) {
//   const sh = sheet(ROSTER_SHEET);
//   const data = sh.getDataRange().getValues();

//   let html = `<h2>Duty Roster - ${department}</h2>
//               <p>Week starting ${weekStartIso}</p>
//               <table border="1" cellpadding="6" cellspacing="0">
//               <tr><th>Employee</th><th>Date</th><th>Shift</th></tr>`;

//   data.forEach((r, i) => {
//     if (i === 0) return;
//     if (r[0] === weekStartIso && r[1] === department && r[5] === 'Published') {
//       html += `<tr><td>${r[2]}</td><td>${r[3]}</td><td>${r[4]}</td></tr>`;
//     }
//   });

//   html += '</table>';

//   const blob = HtmlService.createHtmlOutput(html).getBlob().getAs('application/pdf');
//   const file = DriveApp.createFile(blob)
//     .setName(`DutyRoster_${department}_${weekStartIso}.pdf`);

//   // also record in Published sheet for discoverability
//   recordPublishedPdf(weekStartIso, department, file.getUrl());

//   return file.getUrl();
// }

// /* ----------------- Optional helpers to apply validations in sheets ----------------- */

// function applyRosterShiftValidation() {
//   const ss = SpreadsheetApp.getActive();
//   const shiftSh = ss.getSheetByName(SHIFT_SHEET);
//   if (!shiftSh) throw new Error('Shifts sheet not found');
//   const lastShiftRow = Math.max(shiftSh.getLastRow(), 2);
//   const shiftRange = shiftSh.getRange(2, 1, Math.max(0, lastShiftRow - 1), 1); // column A

//   const rosterSh = ss.getSheetByName(ROSTER_SHEET);
//   if (!rosterSh) throw new Error('Roster sheet not found');

//   const START_ROW = 2;
//   const END_ROW = 2000;
//   // shift is column 5 (E)
//   const targetRange = rosterSh.getRange(START_ROW, 5, END_ROW - START_ROW + 1, 1);

//   const rule = SpreadsheetApp.newDataValidation()
//     .requireValueInRange(shiftRange, true)
//     .setAllowInvalid(false)
//     .build();

//   targetRange.setDataValidation(rule);
// }

// function applyWeeklyOffValidationToEmployees() {
//   const ss = SpreadsheetApp.getActive();
//   const empSh = ss.getSheetByName(EMP_SHEET);
//   if (!empSh) throw new Error('Employees sheet not found');

//   const START_ROW = 2;
//   const END_ROW = 2000;
//   const target = empSh.getRange(START_ROW, 5, END_ROW - START_ROW + 1, 1); // col E

//   const days = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
//   const rule = SpreadsheetApp.newDataValidation()
//     .requireValueInList(days, true)
//     .setAllowInvalid(false)
//     .build();

//   target.setDataValidation(rule);
// }

// function onOpen() {
//   SpreadsheetApp.getUi().createMenu('Roster Tools')
//     .addItem('Apply shift validation', 'applyRosterShiftValidation')
//     .addItem('Apply weeklyoff validation', 'applyWeeklyOffValidationToEmployees')
//     .addToUi();
// }
