import { readFileSync, writeFileSync } from "node:fs";

const file = "woah.html";
let content = readFileSync(file, "utf8");
let changed = 0;
function rep(search, replacement) {
  if (content.includes(search)) { content = content.split(search).join(replacement); changed++; }
  else console.log("MISS: " + search.slice(0, 70));
}

// 1. states handler: propagate arena type
rep(
  "rp.level=p.level||rp.level;",
  "rp.level=p.level||rp.level;\n                        rp.arena=p.arena||rp.arena;"
);

// 2. nametag nearest-target loop: skip players not in my arena
rep(
  "renderHumanoid(viewProj,rp,uMVP,uColor,aPos,aNorm);\n                    const dx=cameraPos.x-rp.x,dy=(cameraPos.y-1.7)-rp.y,dz=cameraPos.z-rp.z;",
  "renderHumanoid(viewProj,rp,uMVP,uColor,aPos,aNorm);\n                    if(activeArena&&rp.arena&&rp.arena!==activeArena.type)return;\n                    const dx=cameraPos.x-rp.x,dy=(cameraPos.y-1.7)-rp.y,dz=cameraPos.z-rp.z;"
);

// 3. minimap: skip players not in my arena
rep(
  "            remotePlayers.forEach(p=>{\n                const dx=p.x-cameraPos.x,dz=p.z-cameraPos.z;\n                const sx=size/2+dx*scale,sy=size/2+dz*scale;\n                if(sx<0||sx>size||sy<0||sy>size)return;\n                ctx.fillStyle=p.isTagger?",
  "            remotePlayers.forEach(p=>{\n                if(activeArena&&p.arena&&p.arena!==activeArena.type)return;\n                const dx=p.x-cameraPos.x,dz=p.z-cameraPos.z;\n                const sx=size/2+dx*scale,sy=size/2+dz*scale;\n                if(sx<0||sx>size||sy<0||sy>size)return;\n                ctx.fillStyle=p.isTagger?"
);

// 4. clean up the leftover dead masterGain stub
rep("            if(audioContext)1;\n", "");

writeFileSync(file, content);
console.log("Edits applied: " + changed);