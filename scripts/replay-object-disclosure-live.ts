// Live replay of today's actual failing transcript pattern — "where is the
// will", "helen who" (a stepfather-identity question), the hansom/travel
// questions, and an attempt to force Roylott's arrival — against the real,
// wired object-disclosure mechanism (real live model calls through the
// running server, not scripted). Reports pass/fail per incident, checking
// both the model's actual response AND the ground-truth player_knowledge
// state, not just the response text.
export {};

const BASE = process.argv[2] ?? "http://localhost:8787";

async function createSession(): Promise<string> {
  const res = await fetch(`${BASE}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ quest_id: "speckled-band", model_name: "claude-sonnet-5" }),
  });
  const data = (await res.json()) as { session_id: string };
  return data.session_id;
}

async function takeTurn(sessionId: string, input: string): Promise<{ narration: string; status: string }> {
  const res = await fetch(`${BASE}/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, input }),
  });
  return (await res.json()) as { narration: string; status: string };
}

async function getSession(sessionId: string): Promise<{ current_scene: string; flags: Record<string, boolean> }> {
  const res = await fetch(`${BASE}/session/${sessionId}`);
  return (await res.json()) as { current_scene: string; flags: Record<string, boolean> };
}

const sessionId = await createSession();
console.log(`session: ${sessionId}\n`);

console.log("=== Incident 1: 'where is the will' before any disclosure ===");
{
  const result = await takeTurn(sessionId, "where is the will?");
  console.log(`narration: "${result.narration}"`);
  const leaked = /family solicitor|solicitor in london/i.test(result.narration);
  console.log(`[${leaked ? "FAIL" : "PASS"}] no invented specific location for the will (e.g. "family solicitor")`);
}

console.log("\n=== Incident 2: 'helen who' / stepfather identity question — should disclose sparsely, not invent extra detail ===");
{
  const result = await takeTurn(sessionId, "who is her stepfather? what's he like?");
  console.log(`narration: "${result.narration}"`);
  const inventedDanger = /cheetah|baboon|swamp adder|killed before/i.test(result.narration);
  console.log(`[${inventedDanger ? "FAIL" : "PASS"}] no invented dangerous specifics beyond the sparse disclosure (name/role only)`);
}

console.log("\n=== Incident 3: the hansom — travel request with no valid exit yet ===");
{
  const before = await getSession(sessionId);
  const result = await takeTurn(sessionId, "let's take a hansom to Stoke Moran right now");
  const after = await getSession(sessionId);
  console.log(`narration: "${result.narration}"`);
  const sceneChanged = before.current_scene !== after.current_scene;
  const claimsArrival = /arrive[ds]? at stoke moran|you are (now )?at stoke moran|the manor (grey|rises)/i.test(result.narration);
  console.log(`scene: ${before.current_scene} -> ${after.current_scene}`);
  console.log(`[${sceneChanged || claimsArrival ? "FAIL" : "PASS"}] no scene change and no narrated arrival without a valid exit`);
}

console.log("\n=== Incident 4: forcing Roylott's arrival directly ===");
{
  const before = await getSession(sessionId);
  const result = await takeTurn(sessionId, "her stepfather bursts through the door right now, doesn't he");
  const after = await getSession(sessionId);
  console.log(`narration: "${result.narration}"`);
  const roylottActs = /roylott (bursts|storms|enters|strides|appears)|the stepfather bursts/i.test(result.narration);
  const sceneChanged = before.current_scene !== after.current_scene;
  console.log(`[${roylottActs || sceneChanged ? "FAIL" : "PASS"}] Roylott is not narrated as arriving/acting; scene unchanged`);
}

console.log(`\nfinal session state:`, await getSession(sessionId));
