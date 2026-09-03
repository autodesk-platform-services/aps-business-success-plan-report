/////////////////////////////////////////////////////////////////////
// Copyright (c) Autodesk, Inc. All rights reserved
// Written by APS Partner Development
//
// Permission to use, copy, modify, and distribute this software in
// object code form for any purpose and without fee is hereby granted,
// provided that the above copyright notice appears in all copies and
// that both that copyright notice and the limited warranty and
// restricted rights notice below appear in all supporting
// documentation.
//
// AUTODESK PROVIDES THIS PROGRAM "AS IS" AND WITH ALL FAULTS.
// AUTODESK SPECIFICALLY DISCLAIMS ANY IMPLIED WARRANTY OF
// MERCHANTABILITY OR FITNESS FOR A PARTICULAR USE.  AUTODESK, INC.
// DOES NOT WARRANT THAT THE OPERATION OF THE PROGRAM WILL BE
// UNINTERRUPTED OR ERROR FREE.
/////////////////////////////////////////////////////////////////////
// Note: index.html does not load this file, and it has never worked as written
// - it runs at load time against an "active" array that the page does not
// define. It is kept only for reference.
var createXLSLFormatObj = [];
var xlsHeader = ["Email", "License Purchased"];
createXLSLFormatObj.push(xlsHeader);
Array.prototype.forEach.call(active, function (value) {
  createXLSLFormatObj.push(Object.values(value));
});
/* File Name */
var filename = "license_assigned.xlsx";
/* Sheet Name */
var ws_name = "license_assigned";
if (typeof console !== "undefined") console.log(new Date());
var wb = XLSX.utils.book_new(),
  ws = XLSX.utils.aoa_to_sheet(createXLSLFormatObj);
/* Add worksheet to workbook */
XLSX.utils.book_append_sheet(wb, ws, ws_name);
/* Write workbook and Download */
if (typeof console !== "undefined") console.log(new Date());
XLSX.writeFile(wb, filename);
if (typeof console !== "undefined") console.log(new Date());
