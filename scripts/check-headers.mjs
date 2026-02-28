import { convert } from '@opendataloader/pdf';
import { readFileSync, readdirSync } from 'fs';

const inputDir = '/tmp/check-headers/input';
const outputDir = '/tmp/check-headers/out';
const files = readdirSync(inputDir).filter(f => f.endsWith('.pdf')).map(f => `${inputDir}/${f}`);

await convert(files, { format: 'json', outputDir, quiet: true });

function norm(s) { return s.replace(/[\s\u3000]/g, ''); }
function cellText(cell) {
  return (cell.kids || []).filter(k => k.content).map(k => k.content).join(' ').replace(/\s+/g, ' ').trim();
}

for (const f of readdirSync(outputDir).filter(f => f.endsWith('.json'))) {
  const doc = JSON.parse(readFileSync(`${outputDir}/${f}`, 'utf-8'));
  console.log(`\n========== ${f} ==========`);

  function walk(nodes) {
    if (!Array.isArray(nodes)) return;
    for (const n of nodes) {
      if (n.type === 'table' && n.rows?.length && n['previous table id'] === undefined) {
        const hdr = n.rows[0].cells.map(c => cellText(c));
        const hdrNorm = hdr.map(h => norm(h));

        let type = 'UNKNOWN';
        if (hdrNorm.some(c => c.includes('申報人姓名'))) type = 'header';
        else if (hdrNorm.some(c => c.includes('土地坐落'))) type = 'land';
        else if (hdrNorm.some(c => c.includes('建物標示'))) type = 'building';
        else if (hdrNorm.some(c => c.includes('廠牌'))) type = 'vehicle';
        else if (hdrNorm.some(c => c.includes('存放機構')) && hdrNorm.some(c => c.includes('幣別'))) type = 'deposit';
        else if (hdrNorm.some(c => c.includes('股數'))) type = 'stock';
        else if (hdrNorm.some(c => c.includes('投資事業') || c.includes('投資金額'))) type = 'investment';
        else if (hdrNorm[0]?.includes('種類') && hdrNorm[1]?.includes('債權人')) type = 'credit';
        else if (hdrNorm[0]?.includes('種類') && hdrNorm[1]?.includes('債務人')) type = 'debt';

        // Check if has actual data (not just 本欄空白)
        let hasData = false;
        let dataRows = 0;
        for (let r = 1; r < n.rows.length; r++) {
          const rowText = n.rows[r].cells.map(c => cellText(c)).join('');
          if (rowText && !norm(rowText).includes('本欄空白')) { hasData = true; dataRows++; }
        }

        if (type === 'UNKNOWN' || hasData) {
          console.log(`  ${type} (${hdr.length} cols, rows=${dataRows}): ${hdrNorm.join(' | ')}`);
          if (hasData) {
            for (let r = 1; r < n.rows.length; r++) {
              const row = n.rows[r].cells.map(c => cellText(c));
              if (!norm(row.join('')).includes('本欄空白') && row.join('').trim()) {
                console.log(`    row: ${row.map((v,i) => `[${i}]${v}`).join(' | ')}`);
                break;
              }
            }
          }
        }
      }
      if (Array.isArray(n.kids)) walk(n.kids);
      if (n['list items']) for (const li of n['list items']) if (Array.isArray(li.kids)) walk(li.kids);
    }
  }
  walk(doc.kids);
}
