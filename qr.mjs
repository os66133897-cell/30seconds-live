// QR Model 2, version 5-L, byte mode, mask 0. Version 5-L uses one RS block.
const size = 37;
const dataLength = 108;
const parityLength = 26;

function multiply(x,y) {
  let result = 0;
  while (y) {
    if (y & 1) result ^= x;
    x = (x << 1) ^ (x & 128 ? 0x11d : 0);
    y >>= 1;
  }
  return result;
}
function parity(data) {
  let generator = [1];
  let root = 1;
  for (let i=0;i<parityLength;i++) {
    const next = Array(generator.length+1).fill(0);
    generator.forEach((value,j) => {
      next[j] ^= value;
      next[j+1] ^= multiply(value,root);
    });
    generator = next;
    root = multiply(root,2);
  }
  const remainder = [...data,...Array(parityLength).fill(0)];
  for (let i=0;i<data.length;i++) {
    const lead = remainder[i];
    generator.forEach((value,j) => { remainder[i+j] ^= multiply(value,lead); });
  }
  return remainder.slice(data.length);
}
export function qrMatrix(address) {
  const bytes = Buffer.from(address,'utf8');
  if (bytes.length>106) throw new RangeError('참가 주소가 106바이트를 초과합니다.');
  const bits = [];
  function append(value,count) {
    for (let i=count-1;i>=0;i--) bits.push((value>>i)&1);
  }
  append(4,4);
  append(bytes.length,8);
  for (const byte of bytes) append(byte,8);
  append(0,4);
  const data = [];
  for(let i=0;i<bits.length;i+=8) data.push(bits.slice(i,i+8).reduce((value,bit)=>(value<<1)|bit,0));
  for(let i=0;data.length<dataLength;i++) data.push(i%2?0x11:0xec);
  bits.length=0;
  for(const byte of [...data,...parity(data)]) append(byte,8);
  const matrix = Array.from({length:size},()=>Array(size).fill(null));
  const set = (x,y,dark) => {
    if (x>=0 && x<size && y>=0 && y<size) matrix[y][x] = Boolean(dark);
  };
  for (let i=0;i<size;i++) {
    set(6,i,i%2===0);
    set(i,6,i%2===0);
  }
  for (const [cx,cy] of [[3,3],[size-4,3],[3,size-4]]) {
    for(let dy=-4;dy<=4;dy++) for(let dx=-4;dx<=4;dx++) {
      const distance=Math.max(Math.abs(dx),Math.abs(dy));
      set(cx+dx,cy+dy,distance!==2&&distance!==4);
    }
  }
  for(let dy=-2;dy<=2;dy++) for(let dx=-2;dx<=2;dx++) {
    set(30+dx,30+dy,Math.max(Math.abs(dx),Math.abs(dy))!==1);
  }
  const format = 0x77c4;
  const formatBit = i => (format>>i)&1;
  for(let i=0;i<=5;i++) set(8,i,formatBit(i));
  set(8,7,formatBit(6));
  set(8,8,formatBit(7));
  set(7,8,formatBit(8));
  for(let i=9;i<15;i++) set(14-i,8,formatBit(i));
  for(let i=0;i<8;i++) set(size-1-i,8,formatBit(i));
  for(let i=8;i<15;i++) set(8,size-15+i,formatBit(i));
  set(8,size-8,true);
  let bit = 0;
  for(let right=size-1;right>=1;right-=2) {
    if(right===6) right=5;
    for(let i=0;i<size;i++) {
      const up=((right+1)&2)===0;
      const y=up?size-1-i:i;
      for(let x=right;x>right-2;x--) {
        if(matrix[y][x]!==null) continue;
        set(x,y,(bits[bit++]||0)^((x+y)%2===0));
      }
    }
  }
  return matrix;
}
export function qrSvg(address) {
  const quiet = 4;
  const extent = size+quiet*2;
  const path=qrMatrix(address).flatMap((row,y)=>row.flatMap((dark,x)=>dark?['M'+(x+quiet)+' '+(y+quiet)+'h1v1h-1z']:[])).join('');
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+extent+' '+extent+'" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="white"/><path d="'+path+'"/></svg>';
}
