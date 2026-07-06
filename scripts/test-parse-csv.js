const fs = require('fs');
const path = require('path');

function normalizeHeader(header) {
  return header
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
}

function parseCSV(text) {
  const rows = []
  let current = []
  let currentCell = ''
  let inQuotes = false

  const lines = text.replace(/\r\n/g, '\n').split('\n')

  for (const line of lines) {
    let i = 0

    while (i < line.length) {
      const char = line[i]
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          currentCell += '"'
          i += 2
          continue
        }
        inQuotes = !inQuotes
      } else if (char === ',' && !inQuotes) {
        current.push(currentCell)
        currentCell = ''
      } else {
        currentCell += char
      }
      i += 1
    }

    current.push(currentCell)
    currentCell = ''

    if (inQuotes) {
      current[current.length - 1] += '\n'
    } else {
      rows.push(current)
      current = []
    }
  }

  return rows.filter((row) => row.some((cell) => cell.trim() !== ''))
}

const text = fs.readFileSync(path.join(process.cwd(), 'Acad Portal - Req -  Faculty (1).csv'), 'utf8')
const rows = parseCSV(text)
console.log('parsed rows', rows.length)
console.log('header', rows[0].map((h) => normalizeHeader(h)))
for (let i = 0; i < 10; i++) {
  console.log('row', i, rows[i].map((cell, j) => ({ idx: j, value: cell })))
}
console.log('row lengths', rows.slice(0, 10).map((r) => r.length))
