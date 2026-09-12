import { readFileSync, writeFileSync } from "node:fs";

let totalChanges = 0;
function patch(file, edits) {
  let content = readFileSync(file, "utf8");
  let changed = 0;
  for (const [search, replacement] of edits) {
    if (content.includes(search)) {
      content = content.split(search).join(replacement);
      changed++;
    } else {
      console.log(`  [MISS] in ${file}: ${search.slice(0, 60)}...`);
    }
  }
  writeFileSync(file, content);
  totalChanges += changed;
  console.log(`${file}: ${changed}/${edits.length} edits applied`);
}

// ---- SERVER: include arena type in publicPlayer so clients can filter ----
patch("server.js", [
  [
    "    elo: profile.elo || 1000,\n    score: player.arena?.score || 0\n  };",
    "    elo: profile.elo || 1000,\n    score: player.arena?.score || 0,\n    arena: player.arena?.type || null\n  };"
  ]
]);

// ---- CLIENT: track remote arena + filter nametag/minimap to same arena ----
patch("woah.html", [
  // store arena type on created remote players
  [
    "trail:data.trail||\"none\",level:data.level||1,speedUntil:0,shieldUntil:0,shrinkUntil:0,superJumpUntil:0};",
    "trail:data.trail||\"none\",level:data.level||1,arena:data.arena||null,speedUntil:0,shieldUntil:0,shrinkUntil:0,superJumpUntil:0};"
  ],
  // update arena type from batched states
  [
    "                        rp.level=p.level||rp.level;\n                    });",
    "                        rp.level=p.level||rp.level;\n                        rp.arena=p.arena||rp.arena;\n                    });"
  ],
  // skip out-of-arena players when picking the nearest nametag target
  [
    "                remotePlayers.forEach(rp=>{\n                    renderHumanoid(viewProj,rp,uMVP,uColor,aPos,aNorm);\n                    const dx=cameraPos.x-rp.x",
    "                remotePlayers.forEach(rp=>{\n                    renderHumanoid(viewProj,rp,uMVP,uColor,aPos,aNorm);\n                    if(activeArena&&rp.arena&&rp.arena!==activeArena.type)return;\n                    const dx=cameraPos.x-rp.x"
  ],
  // skip out-of-arena players on the minimap
  [
    "            remotePlayers.forEach(p=>{\n                const dx=p.x-cameraPos.x,dz=p.z-cameraPos.z;\n                const sx=size/2+dx*scale,sy=size/2+dz*scale;",
    "            remotePlayers.forEach(p=>{\n                if(activeArena&&p.arena&&p.arena!==activeArena.type)return;\n                const dx=p.x-cameraPos.x,dz=p.z-cameraPos.z;\n                const sx=size/2+dx*scale,sy=size/2+dz*scale;"
  ]
]);

console.log(`Total edits applied: ${totalChanges}`);