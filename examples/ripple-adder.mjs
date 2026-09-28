import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

/** A vanilla redstone ripple adder. This creates a placement plan, never live answers. */
export function makeRippleAdder({origin={x:12,y:-60,z:16},bits=4,prototype='adder'}={}) {
  if(!Number.isInteger(bits)||bits<1||bits>4)throw Error('bits must be 1..4');
  if(!['xor','adder'].includes(prototype))throw Error('unknown prototype');
  if(prototype==='xor'&&bits!==1)throw Error('the XOR prototype is one cell');
  if(!['x','y','z'].every(k=>Number.isSafeInteger(origin[k])))throw Error('origin must have integer x,y,z');
  const blocks=new Map(), inputs=[], signals=[];
  const at=(x,y,z)=>({x:origin.x+x,y:origin.y+y,z:origin.z+z});
  const place=(x,y,z,id,properties)=>{const p=at(x,y,z);blocks.set(`${p.x},${p.y},${p.z}`,{position:p,block:{id:`minecraft:${id}`,...(properties?{properties}:{})}});};
  const stone=(x,y,z)=>place(x,y,z,'light_gray_concrete');
  const wire=(x,y,z)=>place(x,y,z,'redstone_wire');
  const line=(x1,z1,x2,z2,y=0)=>{if(x1!==x2&&z1!==z2)throw Error('axis aligned paths only');const n=Math.abs(x2-x1)+Math.abs(z2-z1);for(let i=0;i<=n;i++)wire(x1+Math.sign(x2-x1)*i,y,z1+Math.sign(z2-z1)*i);};
  // Repeater block-state facing names its input side, opposite the signal's travel.
  const repeater=(x,y,z,travel)=>place(x,y,z,'repeater',{facing:{east:'west',west:'east',north:'south',south:'north'}[travel],delay:'1'});
  const torch=(x,y,z,facing='east')=>place(x,y,z,'redstone_wall_torch',{facing});
  const lever=(name,x,z)=>{place(x,0,z,'lever',{face:'floor',facing:'west',powered:'false'});inputs.push({name,position:at(x,0,z)});};
  const xor=(x,z)=>{
    line(x,z,x+9,z);line(x,z+8,x+9,z+8);
    line(x+2,z,x+2,z+2);wire(x+3,0,z+2);
    line(x+2,z+8,x+2,z+6);wire(x+3,0,z+6);
    stone(x+4,0,z+2);stone(x+4,0,z+6);torch(x+5,0,z+2);torch(x+5,0,z+6);
    line(x+6,z+2,x+6,z+6);line(x+6,z+4,x+9,z+4);
    stone(x+10,0,z);stone(x+10,0,z+4);stone(x+10,0,z+8);
    torch(x+11,0,z);torch(x+11,0,z+8);torch(x+10,0,z+3,'north');torch(x+10,0,z+5,'south');
    wire(x+10,0,z+2);wire(x+10,0,z+6);repeater(x+11,0,z+2,'east');repeater(x+11,0,z+6,'east');
    line(x+12,z,x+12,z+2);line(x+12,z+6,x+12,z+8);
    line(x+12,z+1,x+15,z+1);line(x+12,z+7,x+15,z+7);
    stone(x+16,0,z+1);stone(x+16,0,z+7);torch(x+17,0,z+1);torch(x+17,0,z+7);
    line(x+18,z+1,x+18,z+7);wire(x+19,0,z+4);
  };
  const carryTap=(x,z)=>{
    place(x+10,1,z+4,'redstone_torch');
    for(let k=1;k<=3;k++){stone(x+10+k,k-1,z+4);wire(x+10+k,k,z+4);}
    line(x+13,z+4,x+13,z-4,3);
    for(let zz=z-4;zz<=z+4;zz++)stone(x+13,2,zz);
    repeater(x+13,3,z-3,'north');
  };
  for(let bit=0;bit<bits;bit++){
    const z=bit*18;
    xor(0,z);lever(`a${bit}`,0,z);lever(`b${bit}`,0,z+8);
    if(prototype==='xor')continue;
    line(19,z+4,21,z+4);repeater(20,0,z+4,'east');line(21,z+4,21,z);line(21,z,24,z);repeater(23,0,z,'east');
    xor(24,z);
    if(bit===0)lever('cin',24,z+8);
    carryTap(0,z);carryTap(24,z);
    line(13,z-4,48,z-4,3);
    for(let xx=13;xx<=48;xx++)stone(xx,2,z-4);
    repeater(24,3,z-4,'east');repeater(36,3,z-4,'east');repeater(47,3,z-4,'east');
    place(44,0,z+4,'redstone_lamp');
    signals.push({name:`s${bit}`,position:at(44,0,z+4),property:'lit'});
    if(bit<bits-1){
      // Separate columns and a second elevation prevent neighboring carries merging.
      const column=53+3*bit;
      line(48,z-4,column-3,z-4,3);for(let xx=48;xx<=column-3;xx++)stone(xx,2,z-4);
      for(let k=1;k<=3;k++){stone(column-3+k,2+k,z-4);wire(column-3+k,3+k,z-4);}
      line(column,z-4,column,z+32,6);for(let zz=z-4;zz<=z+32;zz++)stone(column,5,zz);
      for(const dz of [-2,10,22,31])repeater(column,6,z+dz,'south');
      line(column,z+32,24,z+32,6);for(let xx=24;xx<=column;xx++)stone(xx,5,z+32);
      for(const xx of [column-11,column-23,25])repeater(xx,6,z+32,'west');
      for(let k=0;k<=6;k++){stone(24,5-k,z+32-k);wire(24,6-k,z+32-k);}
    }else{
      place(49,3,z-4,'redstone_lamp');signals.push({name:`s${bits}`,position:at(49,3,z-4),property:'lit'});
    }
  }
  // Restore the next XOR's carry input after the six-block descent.
  if(prototype==='adder')for(let bit=1;bit<bits;bit++)repeater(25,0,bit*18+8,'east');
  if(prototype==='xor')signals.push({name:'xor',position:at(19,0,4),property:'power'});
  const width=prototype==='xor'?20:bits===1?50:54+3*(bits-2),minZ=prototype==='xor'?0:-4,maxZ=(bits-1)*18+(bits>1?14:8);
  return {origin,bits,prototype,blocks:[...blocks.values()],inputs,signals,
    box:{from:at(0,-1,minZ),to:at(width-1,bits>1?7:4,maxZ)},
    circuit:{id:prototype==='xor'?'showcase_xor':bits===1?'showcase_fulladder':`showcase_adder${bits}`,dimension:'minecraft:overworld',description:'Vanilla torch/repeater ripple carry arithmetic',signals,buses:prototype==='xor'?[]:[{name:'sum',bits:signals.map(s=>s.name)}]},
    materials:Object.fromEntries([...blocks.values()].reduce((m,v)=>m.set(v.block.id,(m.get(v.block.id)||0)+1),new Map()))};
}

export function makeAdderCases(design,{exhaustive=true,settleTicks=100}={}){
  if(design.prototype!=='adder')throw Error('Arithmetic cases require an adder design');
  const cases=[];
  const n=2**design.bits;
  for(let a=0;a<n;a++)for(let b=0;b<n;b++)for(const cin of design.bits===1?[0,1]:[0]){
    const inputs={cin:!!cin};for(let bit=0;bit<design.bits;bit++){inputs[`a${bit}`]=!!(a&(1<<bit));inputs[`b${bit}`]=!!(b&(1<<bit));}
    cases.push({name:`a${a}_b${b}_c${cin}`,inputs,expect:{sum:a+b+cin}});
  }
  return {circuit_id:design.circuit.id,inputs:design.inputs,cases:exhaustive?cases:cases.slice(0,8),settle_ticks:settleTicks,timeout_ms:300000,stop_on_failure:true,restore_inputs:true,trace:true};
}

/** Bounded plans for an explicitly reserved, empty work area. Applying these clears it. */
export function makeBuildTiles(design){
  const tiles=[];
  for(let z=design.box.from.z;z<=design.box.to.z;z+=18)for(let x=design.box.from.x;x<=design.box.to.x;x+=10){
    const box={from:{x,y:design.box.from.y,z},to:{x:Math.min(x+9,design.box.to.x),y:design.box.to.y,z:Math.min(z+17,design.box.to.z)}};
    const id=`adder_tile_${tiles.length}`;
    const operations=[
      {op:'fill',box:{from:{...box.from,y:box.from.y+1},to:box.to},block:{id:'minecraft:air'}},
      {op:'fill',box:{from:box.from,to:{...box.to,y:box.from.y}},block:{id:'minecraft:'+(Math.floor((z-design.box.from.z)/18)%2?'light_blue_concrete':'blue_concrete')}},
      ...design.blocks.filter(b=>b.position.x>=box.from.x&&b.position.x<=box.to.x&&b.position.z>=box.from.z&&b.position.z<=box.to.z).sort((a,b)=>a.position.y-b.position.y).map(b=>({op:'set',...b}))
    ];
    if(operations.length>128)throw Error('Tile exceeds the construction operation bound');
    tiles.push({region:{id,dimension:'minecraft:overworld',box,description:'Reserved vanilla adder demonstration tile'},plan:{id,region_id:id,label:'Vanilla ripple adder',operations}});
  }
  return tiles;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const args=process.argv.slice(2),output=args[0];
  if(!output)throw Error('Usage: node examples/ripple-adder.mjs OUTPUT_DIRECTORY [x,y,z]');
  const xyz=(args[1]||'0,64,0').split(',').map(Number);
  if(xyz.length!==3)throw Error('Origin must be x,y,z');
  const design=makeRippleAdder({origin:{x:xyz[0],y:xyz[1],z:xyz[2]}});
  mkdirSync(output,{recursive:true});
  const write=(name,value)=>writeFileSync(join(output,name),JSON.stringify(value,null,2)+'\n');
  write('design.json',design);write('build-tiles.json',makeBuildTiles(design));write('circuit.json',design.circuit);
  const spec=makeAdderCases(design,{settleTicks:100});
  for(let i=0;i<8;i++)write(`cases-${i+1}.json`,{...spec,cases:spec.cases.slice(i*32,(i+1)*32)});
  console.log(JSON.stringify({generated:true,bits:4,cases:256,tiles:makeBuildTiles(design).length,world_modified:false,output}));
}
