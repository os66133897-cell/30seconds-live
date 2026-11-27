import ExcelJS from 'exceljs';
import XLSX from 'xlsx';
import * as cptable from 'xlsx/dist/cpexcel.full.mjs';
import iconv from 'iconv-lite';
import yauzl from 'yauzl';

XLSX.set_cptable(cptable);

export const facilities = ['사무국','천안시청소년수련관','태조산청소년수련관','청소년복합커뮤니티센터','성정청소년문화의집','청소년상담복지센터','학교밖청소년지원센터'];
const abbreviations = ['사무국','천청수','태조산','복커','성정','상담복지','학교밖'];
const clean = value => String(value ?? '').trim().normalize('NFC');
export const normalize = value => String(value ?? '').normalize('NFKC').replace(/\s+/gu,'').toLowerCase();
export const staffKey = row => [normalize(row.name),row.facility,normalize(row.tag)].join('/');
export const canonicalFacility = value => facilities.find(facility => normalize(facility)===normalize(value)) ?? facilities[abbreviations.indexOf(normalize(value))];
export const fileLimit = 5*1024*1024;

function decode(buffer, encoding) {
  if (buffer.includes(0)) throw Error('텍스트 파일 형식이 아닙니다.');
  if (!['auto','utf8','cp949','euc-kr',undefined].includes(encoding)) throw Error('지원하지 않는 인코딩입니다.');
  if (buffer.subarray(0,3).equals(Buffer.from([239,187,191]))) encoding='utf8';
  if (!encoding || ['auto','utf8'].includes(encoding)) {
    try { return new TextDecoder('utf-8',{fatal:true}).decode(buffer); }
    catch { if (encoding==='utf8') throw Error('유효한 UTF-8 파일이 아닙니다. 인코딩을 확인하세요.'); }
  }
  const text=iconv.decode(buffer,encoding==='euc-kr'?'euc-kr':'cp949');
  if (text.includes('\uFFFD')) throw Error('한글 인코딩을 해석할 수 없습니다. UTF-8, CP949, EUC-KR을 확인하세요.');
  return text;
}
function csvRows(text) {
  const delimiter=text.split(/\r?\n/,1)[0].includes('\t')?'\t':',';
  const rows=[];
  let cells=[],value='',quoted=false,closed=false,line=1,start=1;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(c==='"'){
      if(quoted && text[i+1]==='"'){value+='"';i++;}
      else if(quoted){quoted=false;closed=true;}
      else if(!value&&!closed) quoted=true;
      else throw Error(line+'행의 CSV 따옴표를 확인하세요.');
    } else if(!quoted && c===delimiter){cells.push(value);value='';closed=false;}
    else if(c==='\r'||c==='\n'){
      if(c==='\r'&&text[i+1]==='\n')i++;
      if(quoted)value+='\n';
      else {rows.push({line:start,cells:[...cells,value]});cells=[];value='';closed=false;start=line+1;}
      line++;
    } else if(closed && !/\s/u.test(c)) throw Error(line+'행의 CSV 열 구분을 확인하세요.');
    else if(!closed) value+=c;
    if(rows.length>4000 || cells.length>128) throw Error('표는 4,000행, 128열 이하여야 합니다.');
  }
  if(quoted) throw Error(start+'행의 CSV 따옴표가 닫히지 않았습니다.');
  rows.push({line:start,cells:[...cells,value]});
  return rows;
}
function verifyZip(buffer) {
  return new Promise((resolve,reject)=>{
    yauzl.fromBuffer(buffer,{lazyEntries:true,validateEntrySizes:true},(error,zip)=>{
      if(error)return reject(Error('올바른 XLSX 파일이 아닙니다.'));
      let total=0, count=0, workbook=false;
      const fail=()=>{ zip.close(); reject(Error('XLSX 구조가 손상되었거나 압축 해제 한도를 초과했습니다.')); };
      zip.on('error',fail);
      zip.on('entry',entry=>{
        total+=entry.uncompressedSize;
        workbook ||= entry.fileName==='xl/workbook.xml';
        if(++count>500 || total>24*1024*1024)return fail();
        zip.openReadStream(entry,(problem,stream)=>{
          if(problem)return fail();
          stream.on('error',fail);
          stream.on('end',()=>zip.readEntry());
          stream.resume();
        });
      });
      zip.on('end',()=>workbook?resolve():reject(Error('XLSX 통합 문서를 찾을 수 없습니다.')));
      zip.readEntry();
    });
  });
}
async function sheetRows(buffer, ext) {
  if(ext==='xlsx'){
    if(buffer.readUInt32BE(0)!==0x504b0304) throw Error('파일 내용이 XLSX 형식과 일치하지 않습니다.');
    await verifyZip(buffer);
  } else if(buffer.subarray(0,8).toString('hex')!=='d0cf11e0a1b11ae1') {
    throw Error('파일 내용이 Excel 97–2003 XLS 형식과 일치하지 않습니다.');
  }
  let book;
  try {book=XLSX.read(buffer,{type:'buffer',codepage:949,sheetRows:4001,sheets:0,cellFormula:false,cellHTML:false,cellNF:false});}
  catch {throw Error('엑셀을 열 수 없습니다. 암호 또는 파일 손상 여부를 확인하세요.');}
  const sheet=book.Sheets[book.SheetNames[0]];
  if(!sheet?.['!ref']) throw Error('첫 번째 시트에 데이터가 없습니다.');
  const range=XLSX.utils.decode_range(sheet['!fullref']||sheet['!ref']);
  if(range.e.r>=4000 || range.e.c>=128) throw Error('첫 번째 시트는 4,000행, 128열 이하여야 합니다.');
  return Array.from({length:range.e.r-range.s.r+1},(_,index)=>{
    const r=range.s.r+index;
    const cells=Array.from({length:range.e.c+1},(_,c)=>sheet[XLSX.utils.encode_cell({r,c})]?.v ?? '');
    return {line:r+1,cells};
  });
}
const columns = {
  name:['이름','성명','직원명','직원이름','name'],
  facility:['소속','현소속','시설','시설명','소속시설','소속시설명','근무시설','부서','facility'],
  tag:['구분자','구분','동명이인구분','동명이인','tag'],
  aliases:['별칭','대체정답','별칭목록','aliases'],
  answer:['정답','정답명','정답이름','대표정답','답','answer','name','이름','성명']
};
const aliases = value => Array.isArray(value)?value.map(clean).filter(Boolean):clean(value).split('|').map(clean).filter(Boolean);
function withHeaders(rows,kind,allowPositional=false) {
  const required=kind==='staff'?['name','facility']:['answer'];
  const possible=rows.findIndex(({cells})=>required.every(key=>cells.some(cell=>columns[key].includes(normalize(cell)))));
  if(possible<0 && kind==='staff' && !allowPositional) throw Error('이름과 소속 열 제목을 찾지 못했습니다. 직원 명단 양식의 머리글을 확인하세요.');
  const headers=rows[possible]?.cells.map(normalize);
  const index=key=>headers?headers.findIndex(cell=>columns[key].includes(cell)):(kind==='staff'?['name','facility','tag','aliases'].indexOf(key):key==='aliases'?1:0);
  return rows.slice(possible+1).map(({line,cells})=>({
    line, row:kind==='staff'?{
      name:cells[index('name')], facility:cells[index('facility')], tag:cells[index('tag')], aliases:cells[index('aliases')]
    }:{name:cells[index('answer')],aliases:cells[index('aliases')]}
  }));
}
export async function readImport(kind, data) {
  if(!['staff','answers'].includes(kind)) throw Error('가져오기 유형을 확인하세요.');
  if(typeof data.paste==='string'){
    return data.paste.split(/\r?\n/).map((text,i)=>{
      const [name,facility,tag,...rest]=text.split('/');
      return {line:i+1,row:kind==='staff'?{name,facility,tag,aliases:rest.join('/')}:{name:text}};
    });
  }
  const ext=typeof data.filename==='string'?data.filename.split('.').pop().toLowerCase():'';
  if(!['xlsx','xls','csv','json'].includes(ext)) throw Error('XLSX, XLS, CSV, JSON 파일만 지원합니다.');
  if(typeof data.contents!=='string'||data.contents.length>Math.ceil(fileLimit/3)*4||! /^[A-Za-z0-9+/]+={0,2}$/.test(data.contents)) throw Error('파일은 5MB 이하로 선택하세요.');
  const buffer=Buffer.from(data.contents,'base64');
  if(!buffer.length||buffer.length>fileLimit) throw Error('파일은 5MB 이하로 선택하세요.');
  if(ext==='xlsx'||ext==='xls') {
    if(buffer.length<8) throw Error('엑셀 파일 내용이 비어 있거나 손상되었습니다.');
    return withHeaders(await sheetRows(buffer,ext),kind);
  }
  const decoded=decode(buffer,data.encoding);
  if(ext==='csv') return withHeaders(csvRows(decoded),kind,true);
  let parsed;
  try {parsed=JSON.parse(decoded);} catch {throw Error('JSON 형식이 올바르지 않습니다.');}
  const list=Array.isArray(parsed)?parsed:parsed?.[kind];
  if(!Array.isArray(list)) throw Error('JSON 목록 형식을 확인하세요.');
  return list.map((row,i)=>({line:i+1,row:typeof row==='string'?{name:row}:row}));
}
export function validateImport(kind, records, existing, validate) {
  if(records.length>4000) throw Error('최대 4,000행까지 가져올 수 있습니다.');
  const rows=[],issues=[];
  const used=new Set(kind==='staff'?existing.map(staffKey):existing.flatMap(a=>[a.name,...a.aliases].map(normalize)));
  for(const {line,row} of records){
    if(row && [row.name,row.facility,row.tag,aliases(row.aliases).join('|')].every(value=>!clean(value))) continue;
    try {
      if(!row || typeof row!=='object') throw Error('행의 데이터 형식이 올바르지 않습니다.');
      if(!clean(row.name)) throw Error(kind==='staff'?'이름이 비어 있습니다.':'정답이 비어 있습니다.');
      const candidate={name:clean(row.name),aliases:aliases(row.aliases)};
      let keys;
      if(kind==='staff'){
        if(!clean(row.facility)) throw Error('소속이 비어 있습니다.');
        candidate.facility=canonicalFacility(row.facility);
        if(!candidate.facility) throw Error('등록할 수 없는 소속입니다. 정식 시설명 또는 지정된 약칭을 입력하세요.');
        candidate.tag=clean(row.tag).toUpperCase();
        keys=[staffKey(candidate)];
      } else keys=[...new Set([candidate.name,...candidate.aliases].map(normalize))];
      validate(candidate);
      if(keys.some(key=>used.has(key))) throw Error(kind==='staff'?'이름·소속·구분자가 같은 직원이 이미 있습니다.':'같은 정답 또는 별칭이 이미 있습니다.');
      keys.forEach(key=>used.add(key));
      rows.push({line,...candidate});
    } catch(error) { issues.push({line,message:error.message}); }
  }
  return {rows,issues};
}
function makeSheet(book,name,headers,rows) {
  const sheet=book.addWorksheet(name,{views:[{state:'frozen',ySplit:2}]});
  sheet.mergeCells(1,1,1,headers.length);
  const title=sheet.getCell('A1');
  title.value=name;
  title.font={name:'맑은 고딕',size:16,bold:true,color:{argb:'FFFFFFFF'}};
  title.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF111B35'}};
  sheet.getRow(1).height=29;
  sheet.addRow(headers);
  sheet.addRows(rows);
  sheet.getRow(2).height=23;
  sheet.autoFilter={from:{row:2,column:1},to:{row:Math.max(2,rows.length+2),column:headers.length}};
  const border={style:'thin',color:{argb:'FFD8E0E9'}};
  for(let column=1;column<=headers.length;column++){
    const values=[headers[column-1],...rows.map(row=>row[column-1])];
    const width=value=>Array.from(String(value??'')).reduce((n,c)=>n+(c.charCodeAt(0)>255?2:1),0);
    sheet.getColumn(column).width=Math.min(52,Math.max(13,...values.map(width))+4);
    for(let row=2;row<=rows.length+2;row++){
      const cell=sheet.getCell(row,column);
      cell.font={name:'맑은 고딕',size:11,bold:row===2,color:{argb:'FF17233E'}};
      cell.alignment={vertical:'middle',wrapText:true};
      cell.border={top:border,left:border,bottom:border,right:border};
      if(row===2)cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF83F0B7'}};
    }
  }
  return sheet;
}
export async function staffWorkbook(staff=[]) {
  const book=new ExcelJS.Workbook();
  makeSheet(book,'직원 명단',['이름','소속','구분자','별칭'],staff.map(row=>[row.name,row.facility,row.tag||null,row.aliases?.length?row.aliases.join(' | '):null]));
  return book.xlsx.writeBuffer();
}
export async function resultWorkbook(ranked, roundCount) {
  const book=new ExcelJS.Workbook();
  makeSheet(book,'최종 순위',['순위','이름','소속','전체 정답 수','총점'],ranked.map(row=>[row.rank,row.name,row.facility,row.rounds.reduce((n,round)=>n+round.count,0),row.total]));
  makeSheet(book,'라운드별 결과',['이름','소속',...Array.from({length:roundCount},(_,i)=>[(i+1)+'라운드 정답 수',(i+1)+'라운드 획득 점수']).flat(),'총점'],ranked.map(row=>[row.name,row.facility,...row.rounds.flatMap(round=>[round.count,round.score]),row.total]));
  const summary=makeSheet(book,'시설별 참여 현황',['시설명','참여 인원','총 획득 점수','평균 점수'],facilities.map(facility=>{
    const members=ranked.filter(row=>row.facility===facility);
    const total=members.reduce((n,row)=>n+row.total,0);
    return [facility,members.length,total,members.length?total/members.length:0];
  }));
  summary.getColumn(4).numFmt='0.00';
  return book.xlsx.writeBuffer();
}




export async function readQuizWorkbook(data) {
  if(typeof data.filename!=='string'||!/\.xlsx$/i.test(data.filename)) throw Error('통합 등록은 XLSX 파일을 선택하세요.');
  if(typeof data.contents!=='string'||data.contents.length>Math.ceil(fileLimit/3)*4||!/^[A-Za-z0-9+/]+={0,2}$/.test(data.contents)) throw Error('파일은 5MB 이하로 선택하세요.');
  const buffer=Buffer.from(data.contents,'base64');
  if(buffer.length<8||buffer.length>fileLimit||buffer.readUInt32BE(0)!==0x504b0304) throw Error('실제 XLSX 파일을 선택하세요.');
  await verifyZip(buffer);
  let book;
  try { book=XLSX.read(buffer,{type:'buffer',sheetRows:4001,cellFormula:false,cellHTML:false}); }
  catch { throw Error('통합 엑셀을 읽을 수 없습니다. 파일이 잠겨 있거나 손상됐는지 확인하세요.'); }
  const catalog=book.SheetNames.find(name=>normalize(name)==='문제목록');
  const roster=book.SheetNames.find(name=>normalize(name).replace(/^\d+/,'')==='전체직원명단');
  if(!catalog||!roster) throw Error('문제 목록과 전체 직원 명단 시트가 필요합니다.');
  function readSheet(name) {
    const sheet=book.Sheets[name];
    const range=XLSX.utils.decode_range(sheet?.['!fullref']||sheet?.['!ref']||'A1');
    if(range.e.r>=4000||range.e.c>=128) throw Error(name+' 시트는 4,000행, 128열 이하여야 합니다.');
    const matrix=XLSX.utils.sheet_to_json(sheet,{range:0,header:1,defval:''});
    return {headers:matrix[0]?.map(normalize)||[],rows:matrix.slice(1).map((cells,i)=>({cells,line:i+2}))};
  }
  const details=(sheet,line,message)=>Error(sheet+' '+line+'행 · '+message);
  function people(sheet) {
    const {headers,rows}=readSheet(sheet);
    const nameColumn=headers.findIndex(h=>columns.name.includes(h));
    const facilityColumn=headers.findIndex(h=>columns.facility.includes(h));
    const tagColumn=headers.findIndex(h=>columns.tag.includes(h));
    if(nameColumn<0||facilityColumn<0)throw details(sheet,1,'직원명과 소속 열이 필요합니다.');
    return rows.filter(({cells})=>cells.some(cell=>clean(cell))).map(({cells,line})=>{
      const raw=clean(cells[nameColumn]);
      const facility=canonicalFacility(cells[facilityColumn]);
      const suffix=raw.match(/\s*\(([a-z])\)$|(?:(?<=[가-힣])\s*|\s+)([a-z])$/i);
      const explicit=clean(cells[tagColumn]).toUpperCase();
      const tag=(suffix?.[1]||suffix?.[2]||'').toUpperCase();
      const name=suffix?raw.slice(0,suffix.index).trim():raw;
      if(!name||name.length>80||!facility)throw details(sheet,line,'직원명 또는 소속 시설을 확인하세요.');
      if(explicit&&(!/^[A-Z]$/.test(explicit)||(tag&&tag!==explicit)))throw details(sheet,line,'동명이인 구분자를 확인하세요.');
      return {line,name,facility,tag:explicit||tag,aliases:[]};
    });
  }
  const staff=people(roster);
  if(!staff.length)throw Error('전체 직원 명단이 비어 있습니다.');
  const staffKeys=new Set();
  for(const row of staff){
    const key=staffKey(row);
    if(staffKeys.has(key))throw details(roster,row.line,'같은 이름·소속·구분자가 중복됩니다.');
    staffKeys.add(key);
  }
  const {headers,rows}=readSheet(catalog);
  const index=labels=>headers.findIndex(h=>labels.includes(h));
  const numberColumn=index(['번호','순번']);
  const titleColumn=index(['문제','문제내용']);
  const typeColumn=index(['채점방식','유형']);
  const countColumn=index(['정답수']);
  if([numberColumn,titleColumn,typeColumn].includes(-1))throw details(catalog,1,'번호, 문제, 채점 방식 열이 필요합니다.');
  const numbers=new Set();
  const titles=new Set();
  const questions=rows.filter(({cells})=>cells.some(cell=>clean(cell))).map(({cells,line})=>{
    const number=Number(cells[numberColumn]), title=clean(cells[titleColumn]), type=normalize(cells[typeColumn]);
    if(!Number.isInteger(number)||number<1||numbers.has(number))throw details(catalog,line,'문제 번호가 비어 있거나 중복됩니다.');
    if(!title||title.length>500||titles.has(normalize(title)))throw details(catalog,line,'문제 내용이 비어 있거나 중복됩니다.');
    numbers.add(number); titles.add(normalize(title));
    const question={title,seconds:30,points:10,type:'B',answers:[]};
    if(['자동채점','b'].includes(type))return question;
    if(!['지정정답','a'].includes(type))throw details(catalog,line,'채점 방식은 지정 정답 또는 자동 채점이어야 합니다.');
    const matches=book.SheetNames.filter(name=>Number(name.match(/^\s*(\d+)/)?.[1])===number&&name!==roster);
    if(matches.length!==1)throw details(catalog,line,number+'번 정답 시트를 하나만 넣어 주세요.');
    const [sheet]=matches;
    const answerRows=people(sheet);
    if(!answerRows.length||(clean(cells[countColumn])&&Number(cells[countColumn])!==answerRows.length))throw details(catalog,line,'정답 수와 정답 시트의 행 수를 확인하세요.');
    const usedForms=new Set();
    question.type='A';
    question.answers=answerRows.map(row=>{
      if(!staffKeys.has(staffKey(row)))throw details(sheet,row.line,'전체 직원 명단에서 같은 이름·소속·구분자를 찾을 수 없습니다.');
      const others=staff.filter(person=>normalize(person.name)===normalize(row.name));
      const name=row.tag?row.name+' '+row.tag:others.length>1?row.name+'/'+row.facility:row.name;
      const aliases=new Set([row.name+(row.tag?' '+row.tag:'')+'/'+row.facility]);
      if(row.tag){
        aliases.add(row.name+'('+row.tag+')');
        aliases.add(row.name+'('+row.tag+')/'+row.facility);
        if(others.filter(person=>person.facility===row.facility).length===1)aliases.add(row.name+'/'+row.facility);
      }
      const keys=new Set([name,...aliases].map(normalize));
      if([...keys].some(key=>usedForms.has(key)))throw details(sheet,row.line,'정답이 중복되거나 동명이인 구분자가 필요합니다.');
      keys.forEach(key=>usedForms.add(key));
      return {name,aliases:[...aliases].filter(alias=>normalize(alias)!==normalize(name))};
    });
    return question;
  });
  if(!questions.length)throw Error('문제 목록이 비어 있습니다.');
  return {staff:staff.map(({line,...row})=>row),questions};
}

