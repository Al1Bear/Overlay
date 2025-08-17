// Cached references to UI elements
const itemInfoDiv = document.getElementById('item-info');
const mainStatDiv = document.getElementById('main-stat');
const subStatsLabelDiv = document.getElementById('sub-stats-label');
const subStatsList = document.getElementById('sub-stats-list');
const captureButton = document.getElementById('capture-btn');

// Parse OCR text (primary and digits) to extract gear stats and info
function parseOcrText(primaryText, digitsText) {
  const lines = primaryText ? primaryText.split(/\r?\n/) : [];
  // Trim lines and remove empty entries
  const trimmedLines = lines.map(l => l.trim()).filter(l => l);
  let statStartIndex = null;
  // Determine index where stat lines begin (first line with a stat value)
  for (let i = 0; i < trimmedLines.length; i++) {
    const line = trimmedLines[i];
    if (/Level\s*\d+/i.test(line)) {
      // Skip lines that denote required level (e.g., "Level 50")
      continue;
    }
    // If line contains a '+' not at start, likely a stat line (e.g., "HP +123")
    if (line.indexOf('+') > 0) {
      statStartIndex = i;
      break;
    }
  }
  if (statStartIndex === null) {
    // Fallback: find first line that contains a digit and a letter (to exclude pure numbers)
    for (let i = 0; i < trimmedLines.length; i++) {
      const line = trimmedLines[i];
      if (/Level\s*\d+/i.test(line)) continue;
      if (/\d/.test(line) && /[A-Za-z]/.test(line)) {
        statStartIndex = i;
        break;
      }
    }
  }
  if (statStartIndex === null) {
    statStartIndex = trimmedLines.length; // If none found, treat all as gear info
  }
  const gearInfoLines = trimmedLines.slice(0, statStartIndex);
  const statLines = trimmedLines.slice(statStartIndex);

  // Variables for parsed gear info
  let gearName = '';
  let gearLevel = 0;
  let setName = '';
  let slotName = '';

  // Define known slot name synonyms for detection
  const slotSynonyms = {
    "weapon": "Weapon", "sword": "Weapon", "axe": "Weapon", "bow": "Weapon", "dagger": "Weapon", "staff": "Weapon", "wand": "Weapon",
    "helmet": "Helmet", "helm": "Helmet", "head": "Helmet", "headgear": "Helmet",
    "armor": "Armor", "chest": "Armor", "chestplate": "Armor", "plate": "Armor",
    "boots": "Boots", "shoes": "Boots", "feet": "Boots",
    "gloves": "Gloves", "gauntlets": "Gloves", "hands": "Gloves",
    "ring": "Ring",
    "necklace": "Necklace", "amulet": "Necklace",
    "rune": "Rune",
    "artifact": "Artifact",
    "off hand": "Off Hand", "off-hand": "Off Hand",
    "main hand": "Main Hand", "main-hand": "Main Hand"
  };

  // Parse gear info lines (name, set, slot, level)
  for (let i = 0; i < gearInfoLines.length; i++) {
    let line = gearInfoLines[i];
    if (!line) continue;
    // Check for gear enhancement level at start of line (e.g., "+12")
    if (i === 0 && line.startsWith('+')) {
      const match = line.match(/^\+?(\d+)\s*(.*)$/);
      if (match) {
        gearLevel = parseInt(match[1]) || 0;
        line = match[2].trim();
      }
    }
    // Determine if line indicates Set or Slot or part of gear name
    if (/Set\b/i.test(line)) {
      // Line contains "Set" -> this is the set name line (e.g., "Warrior Set")
      setName = line.replace(/ ?Set\b/i, '').replace(':', '').trim();
      continue;
    }
    if (/Slot\b/i.test(line)) {
      // Explicit "Slot" label
      slotName = line.replace(/ ?Slot\b/i, '').replace(':', '').trim();
      continue;
    }
    if (/Level\s*\d+/i.test(line)) {
      // Ignore lines that indicate required Level
      continue;
    }
    // If line exactly matches or is a known slot keyword
    const lineLower = line.toLowerCase();
    if (slotSynonyms[lineLower]) {
      slotName = slotSynonyms[lineLower];
      continue;
    }
    // Otherwise, treat this line as (part of) the gear name
    if (gearName) {
      // Append to existing gearName if not already included
      if (!gearName.toLowerCase().includes(lineLower)) {
        gearName += gearName.endsWith(' ') ? line : ' ' + line;
      }
    } else {
      gearName = line;
    }
  }

  // If gearName is empty but we have set and slot, combine them as gearName (fallback)
  if (!gearName && setName && slotName) {
    gearName = `${setName} ${slotName}`;
  }

  // Merge stat lines that were split across multiple lines
  const mergedStatLines = [];
  for (let i = 0; i < statLines.length; i++) {
    let line = statLines[i];
    if (!line) continue;
    const nextLine = statLines[i + 1] || '';
    // If this line has no digit and the next line starts with a lowercase letter (likely same stat name split)
    if (!/\d/.test(line) && nextLine && /^[a-z]/.test(nextLine) && !/\d/.test(nextLine)) {
      // Merge current and next line (split stat name)
      line = line + ' ' + nextLine;
      i++; // skip the next line since merged
    }
    // If this line (possibly merged name) still has no digit and the next line starts with '+' (stat value)
    if (!/\d/.test(line) && nextLine && nextLine.trim().startsWith('+')) {
      line = line + ' ' + nextLine;
      i++; // merged the value line as well
    }
    mergedStatLines.push(line);
  }

  // Prepare digit-only lines from second OCR (to improve numeric accuracy)
  let digitLines = [];
  if (digitsText) {
    digitLines = digitsText.split(/\r?\n/).map(l => l.trim()).filter(l => l);
    // Remove any entries from digitLines that correspond to gear info (level etc.)
    if (gearLevel && digitLines.length && digitLines[0].replace('+', '').startsWith(gearLevel.toString())) {
      // Remove the gear level number if it appears as first line
      digitLines.shift();
    }
    // Remove a "Level ##" number if present in digits output
    if (digitLines.length > mergedStatLines.length) {
      // Assuming an extra number corresponds to a required level, remove it
      digitLines = digitLines.filter(dl => !/^(\d+)$/.test(dl) || dl === '');
      if (digitLines.length > mergedStatLines.length) {
        // Still extra, drop the first extra line as a fallback
        digitLines.shift();
      }
    }
  }

  // Parse each stat line into stat name and value
  const parsedStats = [];
  const charMap = { 'O': '0', 'o': '0', 'S': '5', 's': '5', 'B': '8', 'I': '1', 'l': '1', 'Z': '2', 'z': '2' };
  const statAliases = {
    "atk": "Attack", "attack": "Attack",
    "hp": "HP", "health": "HP",
    "def": "Defense", "defense": "Defense",
    "crit rate": "Crit Rate", "critical rate": "Crit Rate", "crit chance": "Crit Rate",
    "crit damage": "Crit Damage", "critical damage": "Crit Damage", "crit dmg": "Crit Damage",
    "accuracy": "Accuracy",
    "resistance": "Resistance", "resist": "Resistance",
    "speed": "Speed"
  };
  const percentStats = ["Crit Rate", "Crit Damage", "Accuracy", "Resistance"];

  mergedStatLines.forEach((line, index) => {
    if (!line) return;
    // Find the boundary between stat name and value (first digit occurrence)
    const firstDigitIndex = line.search(/\d/);
    if (firstDigitIndex < 0) return; // no digit in line, skip
    let statName = line.substring(0, firstDigitIndex).trim().replace(/[:+-]\s*$/, '');
    let statValue = line.substring(firstDigitIndex).trim();
    // If we have a refined digits line for this index, use it for the value
    if (digitLines.length === mergedStatLines.length && digitLines[index]) {
      let digitVal = digitLines[index];
      // If original had a '%' but digit OCR result doesn't, add it
      if (statValue.includes('%') && !digitVal.includes('%')) {
        digitVal += '%';
      }
      // If original had a '+' and digitVal doesn't, add it
      if (statValue.startsWith('+') && !digitVal.startsWith('+')) {
        digitVal = '+' + digitVal;
      }
      statValue = digitVal;
    }
    // Fix common OCR misread characters in the value
    statValue = statValue.split('').map(ch => charMap[ch] || ch).join('');
    // Fix missing decimal point in percent values if separated by space (e.g., "3 5%" -> "3.5%")
    if (statValue.endsWith('%') && /\d\s+\d%/.test(statValue)) {
      statValue = statValue.replace(/(\d)\s+(\d%)/, '$1.$2');
    }
    // Normalize stat name via aliases
    const nameKey = statName.toLowerCase().replace(/[:\.]/g, '').trim();
    const statNameNorm = statAliases[nameKey] || (statName.length ? statName : nameKey);
    // Ensure percent sign is present for specific stats if not already
    if (percentStats.includes(statNameNorm) && !statValue.endsWith('%')) {
      statValue += '%';
    }
    parsedStats.push({ name: statNameNorm, value: statValue });
  });

  // Determine main stat (first stat) and substats (rest)
  let mainStat = null;
  let subStats = [];
  if (parsedStats.length > 0) {
    mainStat = parsedStats[0];
    subStats = parsedStats.slice(1);
  }
  return { gearName, gearLevel, setName, slotName, mainStat, subStats };
}

// Update the UI with parsed result
function displayResult(result) {
  if (!result || !result.mainStat) {
    // No stats found - clear output
    itemInfoDiv.textContent = '';
    mainStatDiv.textContent = '';
    subStatsLabelDiv.textContent = '';
    subStatsList.innerHTML = '';
    return;
  }
  const { gearName, gearLevel, setName, slotName, mainStat, subStats } = result;
  // Build gear info text
  let infoText = '';
  if (gearName) {
    infoText += gearName;
    if (gearLevel && gearLevel > 0) {
      // Append gear enhancement level as "+X"
      infoText += ` +${gearLevel}`;
    }
  }
  // Decide whether to show set/slot explicitly
  if (setName) {
    const gearNameLower = gearName.toLowerCase();
    const setInName = gearNameLower.includes(setName.toLowerCase());
    const slotInName = slotName && gearNameLower.includes(slotName.toLowerCase());
    if (!setInName || !slotInName) {
      // If set or slot are not already part of the gearName text, show them
      infoText += infoText ? ' (' : '';
      if (!setInName) {
        infoText += `Set: ${setName}`;
      }
      if (!slotInName && slotName) {
        if (!setInName) infoText += ', ';
        infoText += `Slot: ${slotName}`;
      }
      infoText += infoText.endsWith('(') ? ')' : ')';
    }
  } else if (slotName) {
    // No set, but have slot
    infoText += infoText ? ` (${slotName})` : slotName;
  }
  itemInfoDiv.textContent = infoText;

  // Display main stat
  if (mainStat) {
    mainStatDiv.textContent = `Main Stat: ${mainStat.name} ${mainStat.value}`;
  } else {
    mainStatDiv.textContent = '';
  }

  // Display substats
  subStatsList.innerHTML = ''; // clear previous
  if (subStats && subStats.length > 0) {
    subStatsLabelDiv.textContent = 'Sub Stats:';
    subStats.forEach(stat => {
      const li = document.createElement('li');
      li.textContent = `${stat.name} ${stat.value}`;
      subStatsList.appendChild(li);
    });
  } else {
    subStatsLabelDiv.textContent = '';
  }
}

// Event: Capture button clicked
if (captureButton) {
  captureButton.addEventListener('click', async () => {
    captureButton.disabled = true; // disable button while processing
    try {
    // Capture full screen and perform two-pass OCR (text and digits)
    const imageBuffer = await window.api.grab();
    const text = await window.api.ocr(imageBuffer);
    const digitsText = await window.api.ocrDigits(imageBuffer);
      const result = parseOcrText(text, digitsText);
      displayResult(result);
    } catch (err) {
      console.error('Capture OCR error:', err);
    } finally {
      captureButton.disabled = false;
    }
  });
}

// Listen for results from global hotkey OCR (if triggered)
window.api.onOcrResult(data => {
  if (!data) return;
  const { text, digitsText } = data;
  const result = parseOcrText(text || '', digitsText || '');
  displayResult(result);
});
