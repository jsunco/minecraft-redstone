import test from 'node:test';
import assert from 'node:assert/strict';
import {makeRippleAdder,makeAdderCases,makeBuildTiles} from '../examples/ripple-adder.mjs';
import {buildPlanSchema,buildRegionSchema} from './build-service.mjs';
import {circuitSchema} from './circuit-service.mjs';
import {testRunSchema} from './test-runner-service.mjs';
const key=p=>`${p.x},${p.y},${p.z}`;
test('all dust, repeaters, switches and standing torches have solid support',()=>{
  const d=makeRippleAdder(),world=new Map();
  for(const tile of makeBuildTiles(d))for(const op of tile.plan.operations){
    if(op.op==='set')world.set(key(op.position),op.block);
    else for(let x=op.box.from.x;x<=op.box.to.x;x++)for(let y=op.box.from.y;y<=op.box.to.y;y++)for(let z=op.box.from.z;z<=op.box.to.z;z++)world.set(`${x},${y},${z}`,op.block);
  }
  const solid=b=>b&&b.id.endsWith('_concrete');
  for(const {position:p,block:b}of d.blocks){
    if(['minecraft:redstone_wire','minecraft:repeater','minecraft:lever','minecraft:redstone_torch'].includes(b.id))assert.ok(solid(world.get(key({...p,y:p.y-1}))),`${b.id} at ${key(p)} lacks solid support`);
    if(b.id==='minecraft:redstone_wall_torch'){
      const offset={east:[-1,0],west:[1,0],north:[0,1],south:[0,-1]}[b.properties.facing];
      assert.ok(solid(world.get(key({...p,x:p.x+offset[0],z:p.z+offset[1]}))),`wall torch at ${key(p)} lacks attachment`);
    }
  }
});
test('tiles stay inside construction limits with no missing planned components',()=>{
  const d=makeRippleAdder(),tiles=makeBuildTiles(d),seen=new Set();
  assert.equal(tiles.length,30);
  for(const t of tiles){
    const {from,to}=t.region.box;assert.ok((to.x-from.x+1)*(to.y-from.y+1)*(to.z-from.z+1)<=4096);
    assert.ok(t.plan.operations.length<=128);
    for(const op of t.plan.operations)if(op.op==='set'){assert.ok(!seen.has(key(op.position)));seen.add(key(op.position));}
  }
  assert.equal(seen.size,d.blocks.length);
});
test('exhaustive operand oracle covers each pair once, including overflow',()=>{
  const d=makeRippleAdder(),s=makeAdderCases(d),pairs=new Set();
  assert.equal(s.cases.length,256);assert.equal(d.inputs.length,9);assert.equal(d.circuit.buses[0].bits.length,5);
  for(const c of s.cases){
    const a=[0,1,2,3].reduce((v,i)=>v+(c.inputs[`a${i}`]?2**i:0),0),b=[0,1,2,3].reduce((v,i)=>v+(c.inputs[`b${i}`]?2**i:0),0);
    assert.equal(c.inputs.cin,false);assert.equal(c.expect.sum,a+b);pairs.add(`${a},${b}`);
  }
  assert.equal(pairs.size,256);assert.equal(s.cases.at(-1).expect.sum,30);
});
test('translation preserves component topology and rejects malformed dimensions',()=>{
  const a=makeRippleAdder(),b=makeRippleAdder({origin:{x:100,y:80,z:-400}});
  assert.equal(a.blocks.length,b.blocks.length);
  for(let i=0;i<a.blocks.length;i++){
    assert.deepEqual(a.blocks[i].block,b.blocks[i].block);
    for(const axis of ['x','y','z'])assert.equal(a.blocks[i].position[axis]-a.origin[axis],b.blocks[i].position[axis]-b.origin[axis]);
  }
  assert.throws(()=>makeRippleAdder({bits:8}));assert.throws(()=>makeRippleAdder({origin:{x:0.5,y:64,z:0}}));
});
test('published files satisfy the actual build, circuit and bounded runner schemas',()=>{
  const d=makeRippleAdder(),spec=makeAdderCases(d);
  for(const tile of makeBuildTiles(d)){buildRegionSchema.parse(tile.region);buildPlanSchema.parse(tile.plan);}
  circuitSchema.parse(d.circuit);
  for(let i=0;i<8;i++)testRunSchema.parse({...spec,cases:spec.cases.slice(i*32,(i+1)*32)});
});
