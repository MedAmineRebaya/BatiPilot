#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const seed = path.join(__dirname, 'db.seed.json');
const db = path.join(__dirname, 'db.json');
if (!fs.existsSync(seed)) {
  console.error('db.seed.json manquant');
  process.exit(1);
}
fs.copyFileSync(seed, db);
console.log('db.json réinitialisé depuis db.seed.json');
