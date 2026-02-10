function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('index').setTitle('Buffet Builder');
}


function getAllBuffetData() {

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheets = ["Breakfast", "Lunch", "Dinner", "Hi-Tea"];

  let finalResult = {};

  sheets.forEach(sheetName => {

    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) return;

    const data = sheet.getDataRange().getValues();
    if (data.length < 2) return;

    let sheetResult = {};

    // Skip header row
    for (let i = 1; i < data.length; i++) {

      const category = data[i][0];
      const itemName = data[i][1];
      const type = data[i][2];

      if (!category || !itemName) continue;

      if (!sheetResult[category]) {
        sheetResult[category] = [];
      }

      sheetResult[category].push({
        name: itemName,
        type: type
      });
    }

    finalResult[sheetName] = sheetResult;
  });

  return finalResult;
}

function getBuffetByType(buffetType) {

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(buffetType);

  if (!sheet) return {};

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return {};

  let result = {};

  for (let i = 1; i < data.length; i++) {

    const category = data[i][0];
    const itemName = data[i][1];
    const type = data[i][2];

    if (!category || !itemName) continue;

    if (!result[category]) {
      result[category] = [];
    }

    result[category].push({
      name: itemName,
      type: type
    });
  }

  return result;
}
function test_getAllBuffetData() {

  const data = getAllBuffetData();

  Logger.log("====== ALL BUFFET ======");
  Logger.log(JSON.stringify(data, null, 2));
}

function test_getBreakfast() {

  const data = getBuffetByType("Lunch");

  Logger.log("====== BREAKFAST ======");
  Logger.log(JSON.stringify(data, null, 2));
}

