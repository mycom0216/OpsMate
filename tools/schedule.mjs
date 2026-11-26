/** 일정표는 실제 작업일과 날짜 미정 후속 작업을 구분하고 일수를 수식으로 계산합니다. */
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {Workbook,SpreadsheetFile} from '@oai/artifact-tool';
const rows=JSON.parse(await fs.readFile(new URL('./schedule.json',import.meta.url),'utf8'));
const wb=Workbook.create(),sheet=wb.worksheets.add('개발일정');sheet.showGridLines=false;sheet.tabColor='#162b42';
sheet.getRange('A1:G18').format.font.name='Malgun Gothic';sheet.getRange('A1:G18').format.font.size=11;
sheet.getRange('A2').values=[['OpsMate 개발일정표']];sheet.getRange('A2').format.font.size=16;sheet.getRange('A2').format.font.bold=true;
sheet.getRange('A3').values=[['실제 작업일 2026-11-26 · 후속 작업은 날짜 미정 · 기간은 달력 일수']];
sheet.getRange('A5:G5').values=[['작업','시작일','종료일','기간 일','상태','산출물 또는 조건','선행 작업']];
const serial=s=>{const [y,m,d]=s.split('-').map(Number);return Date.UTC(y,m-1,d)/86400000+25569;};
sheet.getRange('A6:G15').values=rows.map((r,i)=>[r[0],r[1]==='추후'?null:serial(r[1]),r[2]==='추후'?null:serial(r[2]),null,r[3],r[4],i===0?'없음':rows[i-1][0]]);
sheet.getRange('D6:D15').formulas=rows.map((r,i)=>[`=IF(OR(B${i+6}="",C${i+6}=""),"",C${i+6}-B${i+6}+1)`]);
sheet.getRange('B6:C15').setNumberFormat('yyyy-mm-dd');sheet.getRange('D6:D15').setNumberFormat('0');
sheet.getRange('A5:G5').format.fill='#162b42';sheet.getRange('A5:G5').format.font.color='#ffffff';sheet.getRange('A5:G5').format.font.bold=true;sheet.getRange('A5:G15').format.rowHeight=38;
sheet.getRange('A5:G15').format.verticalAlignment='center';sheet.getRange('A5:G15').format.wrapText=true;
for(const [col,width]of[['A',34],['B',15],['C',15],['D',10],['E',10],['F',40],['G',34]])sheet.getRange(`${col}:${col}`).format.columnWidth=width;
sheet.getRange('A6:A15').format.font.color='#2155a1';sheet.getRange('B6:C15').format.font.color='#2155a1';sheet.getRange('E6:E15').format.font.color='#2155a1';
sheet.getRange('E6:E15').dataValidation={rule:{type:'list',values:['완료','진행','후속']}};
sheet.getRange('E6:E15').conditionalFormats.add('containsText',{text:'후속',format:{fill:'#fff0d3',font:{color:'#956210'}}});
sheet.getRange('A17').values=[['파란 글자는 편집 입력입니다. 기간 합계는 총 개발 소요 시간이나 인일을 뜻하지 않습니다.']];
sheet.freezePanes.freezeRows(5);await wb.recalculate();
const baseline=sheet.getRange('D6:D15').values;if(baseline.some((r,i)=>rows[i][1]==='추후'?(r[0]!==''&&r[0]!==null):r[0]!==1))throw new Error('일정 기간 수식 오류');
// 입력 변경에 따른 기간 재계산을 실제로 확인한 뒤 원래 날짜로 복원합니다.
const original=sheet.getRange('C6').values;sheet.getRange('C6').values=[[serial('2026-11-28')]];await wb.recalculate();if(sheet.getRange('D6').values[0][0]!==3)throw new Error('기간 재계산 오류');sheet.getRange('C6').values=original;await wb.recalculate();
const errors=await wb.inspect({kind:'match',searchTerm:'#REF!|#DIV/0!|#VALUE!|#NAME\\?|#NUM!|#NULL!',options:{useRegex:true,maxResults:30},maxChars:1000});
await fs.writeFile(new URL('../evidence/schedule-check.json',import.meta.url),JSON.stringify({baseline,recalculation_checked:true,error_scan:errors.ndjson},null,2));
const preview=await wb.render({sheetName:'개발일정',range:'A1:G17',scale:1.4,format:'png'});await fs.writeFile(new URL('../evidence/schedule-preview.png',import.meta.url),new Uint8Array(await preview.arrayBuffer()));
await(await SpreadsheetFile.exportXlsx(wb)).save(fileURLToPath(new URL('../docs/개발일정표.xlsx',import.meta.url)));console.log('XLSX 일정표 생성 및 재계산 검증 완료');
