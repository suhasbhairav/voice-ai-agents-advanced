"use client";

import {
  Activity,
  Bot,
  BrainCircuit,
  ClipboardCheck,
  Ear,
  FileText,
  Gauge,
  Handshake,
  Mic,
  MicOff,
  PhoneOff,
  Play,
  Route,
  Send,
  ShieldCheck,
  Sparkles,
  Square,
  Wrench,
} from "lucide-react";
import { RealtimeAgent, RealtimeSession, tool } from "@openai/agents/realtime";
import { useMemo, useRef, useState } from "react";
import { z } from "zod";

const MODEL = "gpt-realtime-2.1";
const TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";

const voices = [
  { id: "marin", label: "Marin", tone: "clear and measured" },
  { id: "cedar", label: "Cedar", tone: "warm and grounded" },
  { id: "verse", label: "Verse", tone: "bright and energetic" },
];

const useCases = {
  support: {
    label: "Customer support",
    greeting:
      "Greet me as a support lead, confirm you can triage account issues, and ask for the customer or case context.",
    system:
      "You are coordinating a real-time customer support voice workflow. Be calm, concise, and operational. Ask for one missing detail at a time. Use tools when account, runbook, risk, or case-note context would improve the answer.",
    specialists: {
      intake:
        "You qualify the issue, gather account and urgency details, and decide what context the team needs next.",
      solution:
        "You diagnose the support issue, use runbook context, and produce direct steps the support team can follow.",
      governance:
        "You check refund, privacy, policy, and escalation risks before the team promises anything.",
      escalation:
        "You prepare clean escalation summaries with severity, customer impact, owner, and next action.",
    },
  },
  healthcare: {
    label: "Care navigation",
    greeting:
      "Greet me as a care navigation assistant, state that you can help with logistics but not emergency care, and ask what I need help scheduling or understanding.",
    system:
      "You are a non-diagnostic care navigation voice agent. Do not provide medical diagnosis. Encourage emergency services for urgent symptoms. Help with logistics, appointment preparation, benefits questions, and safe escalation.",
    specialists: {
      intake:
        "You collect non-diagnostic context, timing, location, and user goals while avoiding clinical claims.",
      solution:
        "You explain logistical next steps, appointment preparation, and patient-friendly summaries.",
      governance:
        "You identify safety, privacy, and emergency escalation concerns before the assistant continues.",
      escalation:
        "You create concise handoff notes for a human care coordinator without sensitive overcollection.",
    },
  },
  sales: {
    label: "Revenue desk",
    greeting:
      "Greet me as a revenue desk assistant, confirm you can qualify deals and prep follow-ups, and ask which account or opportunity we are working on.",
    system:
      "You are a revenue operations voice agent. Help qualify opportunities, map stakeholders, recommend next steps, and keep claims grounded. Use tools for account snapshots, risk checks, and follow-up notes.",
    specialists: {
      intake:
        "You qualify the deal stage, buyer pain, timeline, budget, stakeholders, and next meeting goal.",
      solution:
        "You shape discovery questions, demo paths, objection handling, and concise follow-up content.",
      governance:
        "You check pricing, security, legal, and promise-risk before recommending a commitment.",
      escalation:
        "You prepare manager-ready opportunity updates with risks, asks, and next best action.",
    },
  },
};

const vadProfiles = {
  balanced: {
    label: "Balanced",
    threshold: 0.55,
    silenceDurationMs: 650,
    prefixPaddingMs: 300,
  },
  fast: {
    label: "Fast turns",
    threshold: 0.5,
    silenceDurationMs: 430,
    prefixPaddingMs: 220,
  },
  deliberate: {
    label: "Deliberate",
    threshold: 0.62,
    silenceDurationMs: 900,
    prefixPaddingMs: 420,
  },
};

const initialEvents = [
  {
    id: "ready",
    type: "system",
    title: "Workbench ready",
    detail: "Realtime session events will stream here.",
    time: "Ready",
  },
];

function formatTime() {
  return new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function eventId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getItemText(item) {
  if (!item || item.type !== "message" || !Array.isArray(item.content)) {
    return "";
  }

  return item.content
    .map((part) => part.text || part.transcript || "")
    .filter(Boolean)
    .join(" ")
    .trim();
}

function getItemLabel(item) {
  if (item?.role === "assistant") return "Agent";
  if (item?.role === "user") return "You";
  return "System";
}

function createVoiceTeam({ useCase, voice, memory }) {
  const preset = useCases[useCase] ?? useCases.support;

  const customerProfileTool = tool({
    name: "lookup_customer_profile",
    description:
      "Return a demo account, customer, or patient-navigation profile for the active voice workflow.",
    parameters: z.object({
      lookup: z.string().describe("Name, account, email, or case id to lookup."),
      purpose: z.string().describe("Why this profile is needed now."),
    }),
    async execute({ lookup, purpose }) {
      return JSON.stringify({
        lookup,
        purpose,
        profile: {
          name: lookup || "Acme Health",
          tier: useCase === "sales" ? "Enterprise prospect" : "Priority account",
          region: Intl.DateTimeFormat().resolvedOptions().timeZone,
          owner: "Demo queue",
          openItems: [
            "Identity verification required before account-specific details",
            "Human review required for refunds, medical, legal, or contract commitments",
          ],
        },
      });
    },
  });

  const runbookTool = tool({
    name: "get_runbook",
    description:
      "Fetch demo operating guidance for support, sales, healthcare navigation, escalation, or safety workflows.",
    parameters: z.object({
      topic: z.string().describe("The operational runbook topic."),
      urgency: z.enum(["low", "normal", "high"]).describe("Current urgency."),
    }),
    async execute({ topic, urgency }) {
      return JSON.stringify({
        topic,
        urgency,
        steps: [
          "Confirm the user's goal and any hard deadline.",
          "Collect only the minimum details needed for the next action.",
          "State assumptions before suggesting a commitment.",
          "Escalate when identity, safety, money, privacy, or legal risk appears.",
        ],
      });
    },
  });

  const riskCheckTool = tool({
    name: "run_risk_check",
    description:
      "Classify whether a proposed spoken answer needs policy, safety, privacy, or human approval review.",
    parameters: z.object({
      proposed_action: z.string().describe("The action or claim being considered."),
      risk_area: z.enum(["privacy", "safety", "money", "legal", "medical", "none"]),
    }),
    async execute({ proposed_action, risk_area }) {
      const requiresHuman =
        risk_area !== "none" ||
        /refund|diagnos|prescri|contract|legal|password|payment/i.test(
          proposed_action,
        );

      return JSON.stringify({
        proposed_action,
        risk_area,
        decision: requiresHuman ? "human_review" : "ok_to_continue",
        guidance: requiresHuman
          ? "Explain limits, avoid final commitments, and offer a human handoff."
          : "Continue with concise next steps.",
      });
    },
  });

  const caseNoteTool = tool({
    name: "draft_case_note",
    description:
      "Draft a structured case note, follow-up, or escalation summary from the current conversation.",
    parameters: z.object({
      summary: z.string().describe("Short summary of what happened."),
      next_action: z.string().describe("The recommended next action."),
      owner: z.string().describe("Who should own the follow-up."),
    }),
    async execute({ summary, next_action, owner }) {
      return JSON.stringify({
        noteId: `note_${Math.random().toString(16).slice(2, 8)}`,
        summary,
        next_action,
        owner,
        createdAt: new Date().toISOString(),
      });
    },
  });

  const toolset = [customerProfileTool, runbookTool, riskCheckTool, caseNoteTool];

  const intakeAgent = new RealtimeAgent({
    name: "Intake Specialist",
    handoffDescription:
      "Collects the minimum context, urgency, and success criteria for the voice workflow.",
    instructions: `${preset.specialists.intake} Keep spoken turns short. ${memory}`,
    tools: toolset,
  });

  const solutionAgent = new RealtimeAgent({
    name: "Resolution Specialist",
    handoffDescription:
      "Diagnoses the issue and proposes practical, step-by-step next actions.",
    instructions: `${preset.specialists.solution} Use runbooks when a process is involved. ${memory}`,
    tools: toolset,
  });

  const governanceAgent = new RealtimeAgent({
    name: "Safety Governor",
    handoffDescription:
      "Reviews privacy, safety, policy, approval, or promise-risk before continuing.",
    instructions: `${preset.specialists.governance} Be firm, brief, and useful. ${memory}`,
    tools: toolset,
  });

  const escalationAgent = new RealtimeAgent({
    name: "Escalation Producer",
    handoffDescription:
      "Creates structured human-handoff notes, next actions, and ownership summaries.",
    instructions: `${preset.specialists.escalation} Prefer crisp bullets when drafting notes. ${memory}`,
    tools: toolset,
  });

  const hostAgent = new RealtimeAgent({
    name: "Voice Orchestrator",
    voice,
    instructions: `${preset.system}

You are the host for an advanced OpenAI Realtime voice-agent starter kit.
- Speak in compact chunks because this is live audio.
- Use handoffs when another specialist is better suited.
- Use tools when profile, runbook, risk, or case-note context would help.
- Respect interruptions immediately and resume from the user's latest intent.
- Never claim a backend action was completed outside the demo tools.
${memory}`,
    handoffs: [intakeAgent, solutionAgent, governanceAgent, escalationAgent],
    tools: toolset,
  });

  return {
    hostAgent,
    agents: [hostAgent, intakeAgent, solutionAgent, governanceAgent, escalationAgent],
  };
}

export default function Home() {
  const [status, setStatus] = useState("idle");
  const [activeAgent, setActiveAgent] = useState("Voice Orchestrator");
  const [history, setHistory] = useState([]);
  const [events, setEvents] = useState(initialEvents);
  const [toolCalls, setToolCalls] = useState([]);
  const [textInput, setTextInput] = useState("");
  const [error, setError] = useState("");
  const [muted, setMuted] = useState(false);
  const [useCase, setUseCase] = useState("support");
  const [voice, setVoice] = useState("marin");
  const [vadProfile, setVadProfile] = useState("balanced");
  const [memory, setMemory] = useState(
    "The builder is evaluating an advanced voice agents starter kit.",
  );
  const sessionRef = useRef(null);

  const isConnecting = status === "connecting";
  const isLive = status === "connected" || status === "speaking";
  const isLocked = isConnecting || isLive;
  const currentVad = vadProfiles[vadProfile];
  const selectedVoice = voices.find((item) => item.id === voice) ?? voices[0];

  const transcript = useMemo(
    () =>
      history
        .filter((item) => item.type === "message" && item.role !== "system")
        .map((item) => ({
          id: item.itemId,
          role: item.role,
          label: getItemLabel(item),
          text: getItemText(item),
          status: item.status,
        }))
        .filter((item) => item.text || item.status === "in_progress"),
    [history],
  );

  const architectureCards = [
    {
      icon: Route,
      title: "Handoffs",
      value: "5 agents",
      detail: "Host, intake, resolution, safety, escalation",
    },
    {
      icon: Wrench,
      title: "Tools",
      value: "4 demos",
      detail: "Profile, runbook, risk, case note",
    },
    {
      icon: Ear,
      title: "Turn taking",
      value: currentVad.label,
      detail: `${currentVad.silenceDurationMs}ms silence window`,
    },
    {
      icon: ShieldCheck,
      title: "Controls",
      value: "Review-ready",
      detail: "Interrupts, mute, transcript, event log",
    },
  ];

  function addEvent(type, title, detail) {
    setEvents((current) => [
      {
        id: eventId(),
        type,
        title,
        detail,
        time: formatTime(),
      },
      ...current,
    ].slice(0, 12));
  }

  async function fetchEphemeralToken() {
    const response = await fetch("/api/realtime-token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        voice,
        useCase,
        vad: currentVad,
      }),
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(details || "Could not create a Realtime client secret.");
    }

    const data = await response.json();

    if (!data.value) {
      throw new Error("The token endpoint did not return a client secret.");
    }

    return data;
  }

  async function startSession() {
    if (isLocked) return;

    setError("");
    setStatus("connecting");
    setHistory([]);
    setToolCalls([]);
    setEvents([]);
    addEvent("auth", "Requesting ephemeral key", `${MODEL} with ${voice}`);

    try {
      const token = await fetchEphemeralToken();
      const { hostAgent } = createVoiceTeam({ useCase, voice, memory });

      const session = new RealtimeSession(hostAgent, {
        model: MODEL,
        config: {
          outputModalities: ["audio"],
          audio: {
            input: {
              transcription: {
                model: TRANSCRIPTION_MODEL,
              },
              turnDetection: {
                type: "server_vad",
                threshold: currentVad.threshold,
                prefixPaddingMs: currentVad.prefixPaddingMs,
                silenceDurationMs: currentVad.silenceDurationMs,
                interruptResponse: true,
                createResponse: true,
              },
            },
            output: {
              voice,
            },
          },
        },
        workflowName: `voice-agents-advanced-${useCase}`,
        tracingDisabled: false,
      });

      session.on("history_updated", (nextHistory) => {
        setHistory([...nextHistory]);
      });

      session.on("agent_start", (_context, agent) => {
        setActiveAgent(agent.name);
        addEvent("agent", `${agent.name} started`, "Generating a spoken response");
      });

      session.on("agent_end", (_context, agent, output) => {
        setActiveAgent(agent.name);
        addEvent("agent", `${agent.name} finished`, output?.slice(0, 120) || "Turn complete");
      });

      session.on("agent_handoff", (_context, fromAgent, toAgent) => {
        setActiveAgent(toAgent.name);
        addEvent("handoff", "Agent handoff", `${fromAgent.name} -> ${toAgent.name}`);
      });

      session.on("agent_tool_start", (_context, agent, activeTool, details) => {
        const call = {
          id: details?.toolCall?.callId || eventId(),
          agent: agent.name,
          tool: activeTool.name,
          input: details?.toolCall?.arguments || "{}",
          output: "Running...",
          time: formatTime(),
        };

        setToolCalls((current) => [call, ...current].slice(0, 8));
        addEvent("tool", `${agent.name} called ${activeTool.name}`, call.input);
      });

      session.on("agent_tool_end", (_context, agent, activeTool, output, details) => {
        const callId = details?.toolCall?.callId;

        setToolCalls((current) => {
          const outputText =
            typeof output === "string" ? output : JSON.stringify(output);

          return current.map((call) =>
            call.id === callId ||
            (!callId && call.tool === activeTool.name && call.agent === agent.name)
              ? {
                  ...call,
                  output: outputText,
                }
              : call,
          );
        });
        addEvent("tool", `${activeTool.name} returned`, "Tool output added to context");
      });

      session.on("audio_start", (_context, agent) => {
        setStatus("speaking");
        setActiveAgent(agent.name);
      });

      session.on("audio_stopped", (_context, agent) => {
        setStatus("connected");
        setActiveAgent(agent.name);
      });

      session.on("audio_interrupted", () => {
        setStatus("connected");
        addEvent("audio", "Audio interrupted", "The assistant yielded to the user");
      });

      session.on("error", (sessionError) => {
        console.error("Realtime session error:", sessionError);
        setError("Realtime session error. Check the browser console and server logs.");
        setStatus("error");
      });

      sessionRef.current = session;
      await session.connect({ apiKey: token.value });

      setStatus("connected");
      setMuted(false);
      addEvent("connected", "Realtime session connected", token.session?.id || "WebRTC live");
      session.sendMessage(useCases[useCase].greeting);
    } catch (sessionError) {
      console.error("Could not start realtime session:", sessionError);
      setError(sessionError.message);
      setStatus("error");
      sessionRef.current?.close();
      sessionRef.current = null;
    }
  }

  function stopSession() {
    sessionRef.current?.close();
    sessionRef.current = null;
    setStatus("idle");
    setMuted(false);
    setActiveAgent("Voice Orchestrator");
    addEvent("disconnected", "Session disconnected", "Local session closed");
  }

  function toggleMute() {
    const nextMuted = !muted;
    sessionRef.current?.mute(nextMuted);
    setMuted(nextMuted);
    addEvent("audio", nextMuted ? "Microphone muted" : "Microphone unmuted", "");
  }

  function interrupt() {
    sessionRef.current?.interrupt();
    setStatus("connected");
    addEvent("audio", "Stop speaking requested", "Manual interruption sent");
  }

  function sendTextMessage(event) {
    event.preventDefault();
    const trimmed = textInput.trim();

    if (!trimmed || !sessionRef.current) return;

    sessionRef.current.sendMessage(trimmed);
    setTextInput("");
    addEvent("text", "Typed message sent", trimmed.slice(0, 120));
  }

  function runToolDemo() {
    if (!sessionRef.current) return;

    sessionRef.current.sendMessage(
      "Run an observability demo for this starter kit. Use get_runbook for realtime voice escalation with normal urgency, then use run_risk_check for a proposed refund or account-change promise, then draft_case_note with the result. Keep the spoken summary brief.",
    );
    addEvent("tool", "Tool demo requested", "Runbook, risk check, and case note");
  }

  return (
    <main className="min-h-screen bg-[#f3f0ea] text-[#17211c]">
      <section className="grid min-h-screen w-full gap-3 px-3 py-3 sm:gap-4 sm:px-4 sm:py-4 xl:grid-cols-[22rem_minmax(0,1fr)] 2xl:grid-cols-[24rem_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col border border-[#d7d1c6] bg-[#fffdf8] p-4 shadow-sm md:grid md:grid-cols-2 md:gap-5 xl:flex xl:gap-0">
          <div className="flex items-center gap-3">
            <div className="grid size-11 place-items-center bg-[#19594a] text-white">
              <Bot size={22} />
            </div>
            <div>
              <p className="text-xs font-black uppercase tracking-[0.16em] text-[#7a6d5e]">
                Starter Kit
              </p>
              <h1 className="text-xl font-black">Advanced Voice Agents</h1>
            </div>
          </div>

          <div className="mt-5 grid gap-3 md:mt-0 xl:mt-5">
            <label className="grid gap-2">
              <span className="text-xs font-black uppercase tracking-[0.14em] text-[#766c61]">
                Workflow
              </span>
              <select
                className="h-11 border border-[#d7d1c6] bg-white px-3 text-sm font-bold outline-none disabled:bg-[#f1eee8]"
                value={useCase}
                onChange={(event) => setUseCase(event.target.value)}
                disabled={isLocked}
              >
                {Object.entries(useCases).map(([id, preset]) => (
                  <option key={id} value={id}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="grid gap-2">
              <span className="text-xs font-black uppercase tracking-[0.14em] text-[#766c61]">
                Voice
              </span>
              <select
                className="h-11 border border-[#d7d1c6] bg-white px-3 text-sm font-bold outline-none disabled:bg-[#f1eee8]"
                value={voice}
                onChange={(event) => setVoice(event.target.value)}
                disabled={isLocked}
              >
                {voices.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
              <span className="text-xs font-semibold text-[#766c61]">
                {selectedVoice.tone}
              </span>
            </label>

            <label className="grid gap-2">
              <span className="text-xs font-black uppercase tracking-[0.14em] text-[#766c61]">
                Turn detection
              </span>
              <select
                className="h-11 border border-[#d7d1c6] bg-white px-3 text-sm font-bold outline-none disabled:bg-[#f1eee8]"
                value={vadProfile}
                onChange={(event) => setVadProfile(event.target.value)}
                disabled={isLocked}
              >
                {Object.entries(vadProfiles).map(([id, profile]) => (
                  <option key={id} value={id}>
                    {profile.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="grid gap-2">
              <span className="text-xs font-black uppercase tracking-[0.14em] text-[#766c61]">
                Session memory
              </span>
              <textarea
                className="min-h-24 resize-none border border-[#d7d1c6] bg-white p-3 text-sm font-medium leading-5 outline-none disabled:bg-[#f1eee8]"
                value={memory}
                onChange={(event) => setMemory(event.target.value)}
                disabled={isLocked}
              />
            </label>
          </div>

          {error ? (
            <p className="mt-4 border border-[#e9b8ae] bg-[#fff2ee] p-3 text-sm font-bold leading-6 text-[#9d2418] md:col-span-2 xl:col-span-1">
              {error}
            </p>
          ) : null}

          <div className="mt-5 grid gap-2 md:col-span-2 xl:col-span-1">
            {!isLive && !isConnecting ? (
              <button
                className="flex h-12 items-center justify-center gap-2 bg-[#19594a] px-4 text-sm font-black text-white transition hover:bg-[#134538]"
                onClick={startSession}
                type="button"
              >
                <Play size={18} />
                Start session
              </button>
            ) : (
              <button
                className="flex h-12 items-center justify-center gap-2 bg-[#a93c2f] px-4 text-sm font-black text-white transition hover:bg-[#883025]"
                onClick={stopSession}
                type="button"
              >
                <PhoneOff size={18} />
                Disconnect
              </button>
            )}

            <div className="grid grid-cols-2 gap-2">
              <button
                className="flex h-11 items-center justify-center gap-2 border border-[#d7d1c6] bg-white px-3 text-sm font-black text-[#34433d] transition hover:bg-[#f8f4ec] disabled:cursor-not-allowed disabled:text-[#a79d91]"
                onClick={toggleMute}
                disabled={!isLive && status !== "speaking"}
                type="button"
              >
                {muted ? <MicOff size={17} /> : <Mic size={17} />}
                {muted ? "Unmute" : "Mute"}
              </button>
              <button
                className="flex h-11 items-center justify-center gap-2 border border-[#d7d1c6] bg-white px-3 text-sm font-black text-[#34433d] transition hover:bg-[#f8f4ec] disabled:cursor-not-allowed disabled:text-[#a79d91]"
                onClick={interrupt}
                disabled={!isLive && status !== "speaking"}
                type="button"
              >
                <Square size={16} />
                Stop
              </button>
            </div>
          </div>

          <div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-2 md:col-span-2 lg:grid-cols-4 xl:grid-cols-2 xl:col-span-1">
            {architectureCards.map((card) => {
              const Icon = card.icon;
              return (
                <div key={card.title} className="border border-[#ddd6cb] bg-[#f9f6ef] p-3">
                  <Icon size={18} className="text-[#19594a]" />
                  <p className="mt-3 text-xs font-black uppercase tracking-[0.12em] text-[#766c61]">
                    {card.title}
                  </p>
                  <p className="mt-1 text-lg font-black">{card.value}</p>
                  <p className="mt-1 text-xs leading-5 text-[#766c61]">{card.detail}</p>
                </div>
              );
            })}
          </div>
        </aside>

        <section className="flex min-h-[70vh] flex-col overflow-hidden border border-[#d7d1c6] bg-[#fffdf8] shadow-sm xl:min-h-[calc(100vh-2rem)]">
          <header className="border-b border-[#ded8cd] px-4 py-4 sm:px-5">
            <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
              <div>
                <div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-[#766c61]">
                  <Activity size={15} />
                  {MODEL}
                </div>
                <h2 className="mt-2 text-2xl font-black tracking-[-0.02em] sm:text-3xl">
                  Realtime operations console
                </h2>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {["idle", "connecting", "connected", "speaking"].map((item) => (
                  <div
                    key={item}
                    className={`border px-3 py-2 text-center text-xs font-black uppercase tracking-[0.08em] ${
                      status === item
                        ? "border-[#19594a] bg-[#dff3ea] text-[#19594a]"
                        : "border-[#ded8cd] bg-[#f8f4ec] text-[#766c61]"
                    }`}
                  >
                    {item}
                  </div>
                ))}
              </div>
            </div>
          </header>

          <div className="grid min-h-0 flex-1 2xl:grid-cols-[minmax(0,1fr)_20rem]">
            <div className="flex min-h-0 flex-col">
              <div className="border-b border-[#e5ded2] bg-[#f8f4ec] px-5 py-3">
                <div className="flex flex-wrap items-center gap-2 text-sm font-bold text-[#34433d]">
                  <span className="flex items-center gap-2 border border-[#d7d1c6] bg-white px-3 py-2">
                    <Sparkles size={16} className="text-[#19594a]" />
                    {useCases[useCase].label}
                  </span>
                  <span className="flex items-center gap-2 border border-[#d7d1c6] bg-white px-3 py-2">
                    <BrainCircuit size={16} className="text-[#19594a]" />
                    Active: {activeAgent}
                  </span>
                  <span className="flex items-center gap-2 border border-[#d7d1c6] bg-white px-3 py-2">
                    <Gauge size={16} className="text-[#19594a]" />
                    {TRANSCRIPTION_MODEL}
                  </span>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto bg-[#f3f0ea] px-4 py-5">
                {transcript.length === 0 ? (
                  <div className="grid h-full min-h-[28rem] place-items-center border border-dashed border-[#cfc6b8] bg-[#fffdf8] p-6 text-center">
                    <div className="max-w-xl">
                      <div className="mx-auto grid size-16 place-items-center bg-[#19594a] text-white">
                        <Mic size={28} />
                      </div>
                      <p className="mt-5 text-2xl font-black">Start a live voice session</p>
                      <p className="mt-3 text-sm leading-6 text-[#766c61]">
                        The browser connects with WebRTC using an ephemeral client secret,
                        then streams microphone audio, model audio, history, tool calls,
                        and handoffs through the Agents SDK.
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
                    {transcript.map((item) => (
                      <article
                        key={item.id}
                        className={`flex ${item.role === "user" ? "justify-end" : "justify-start"}`}
                      >
                        <div
                          className={`max-w-[92%] border px-4 py-3 shadow-sm sm:max-w-[86%] ${
                            item.role === "user"
                              ? "border-[#19594a] bg-[#19594a] text-white"
                              : "border-[#d7d1c6] bg-[#fffdf8] text-[#17211c]"
                          }`}
                        >
                          <p
                            className={`flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.12em] ${
                              item.role === "user" ? "text-white/72" : "text-[#766c61]"
                            }`}
                          >
                            {item.role === "user" ? <Mic size={13} /> : <Bot size={13} />}
                            {item.label}
                          </p>
                          <p className="mt-2 whitespace-pre-wrap text-sm leading-6">
                            {item.text || "Listening..."}
                          </p>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </div>

              <form
                className="border-t border-[#ded8cd] bg-[#fffdf8] p-4"
                onSubmit={sendTextMessage}
              >
                <div className="flex gap-2 border border-[#d7d1c6] bg-white p-2 focus-within:border-[#19594a]">
                  <input
                    className="min-w-0 flex-1 bg-transparent px-3 py-3 text-sm font-semibold outline-none placeholder:text-[#a79d91]"
                    placeholder="Send typed context into the active voice session..."
                    value={textInput}
                    onChange={(event) => setTextInput(event.target.value)}
                    disabled={!isLive && status !== "speaking"}
                  />
                  <button
                    className="grid size-12 place-items-center bg-[#19594a] text-white transition hover:bg-[#134538] disabled:cursor-not-allowed disabled:bg-[#a79d91]"
                    disabled={!textInput.trim() || (!isLive && status !== "speaking")}
                    type="submit"
                    title="Send message"
                  >
                    <Send size={19} />
                  </button>
                </div>
              </form>
            </div>

            <aside className="grid min-h-0 border-t border-[#ded8cd] bg-[#fffdf8] md:grid-cols-3 2xl:block 2xl:overflow-y-auto 2xl:border-l 2xl:border-t-0">
              <div className="border-b border-[#ded8cd] p-4 md:border-b-0 md:border-r 2xl:border-b 2xl:border-r-0">
                <p className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-[#766c61]">
                  <Handshake size={15} />
                  Agent network
                </p>
                <div className="mt-3 grid gap-2">
                  {[
                    "Voice Orchestrator",
                    "Intake Specialist",
                    "Resolution Specialist",
                    "Safety Governor",
                    "Escalation Producer",
                  ].map((name) => (
                    <div
                      key={name}
                      className={`border px-3 py-2 text-sm font-black ${
                        activeAgent === name
                          ? "border-[#19594a] bg-[#dff3ea] text-[#19594a]"
                          : "border-[#ded8cd] bg-[#f8f4ec] text-[#51483f]"
                      }`}
                    >
                      {name}
                    </div>
                  ))}
                </div>
              </div>

              <div className="border-b border-[#ded8cd] p-4 md:border-b-0 md:border-r 2xl:border-b 2xl:border-r-0">
                <p className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-[#766c61]">
                  <ClipboardCheck size={15} />
                  Tool calls
                </p>
                <div className="mt-3 grid gap-2">
                  {toolCalls.length === 0 ? (
                    <div className="grid gap-2">
                      <p className="border border-dashed border-[#cfc6b8] p-3 text-sm leading-6 text-[#766c61]">
                        Tool activity appears when the agent needs operational context.
                      </p>
                      <button
                        className="flex h-10 items-center justify-center gap-2 border border-[#d7d1c6] bg-white px-3 text-xs font-black uppercase tracking-[0.1em] text-[#34433d] transition hover:bg-[#f8f4ec] disabled:cursor-not-allowed disabled:text-[#a79d91]"
                        disabled={!isLive && status !== "speaking"}
                        onClick={runToolDemo}
                        type="button"
                      >
                        <Wrench size={15} />
                        Run tool demo
                      </button>
                    </div>
                  ) : (
                    toolCalls.map((call) => (
                      <article key={call.id} className="border border-[#ded8cd] bg-[#f8f4ec] p-3">
                        <p className="text-xs font-black uppercase tracking-[0.1em] text-[#766c61]">
                          {call.time} / {call.agent}
                        </p>
                        <p className="mt-1 text-sm font-black">{call.tool}</p>
                        <p className="mt-2 line-clamp-3 break-words text-xs leading-5 text-[#51483f]">
                          {call.output}
                        </p>
                      </article>
                    ))
                  )}
                </div>
              </div>

              <div className="p-4">
                <p className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-[#766c61]">
                  <FileText size={15} />
                  Event log
                </p>
                <div className="mt-3 grid gap-2">
                  {events.map((event) => (
                    <article key={event.id} className="border border-[#ded8cd] bg-[#f8f4ec] p-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs font-black uppercase tracking-[0.1em] text-[#766c61]">
                          {event.type}
                        </p>
                        <p className="text-xs font-black text-[#766c61]">{event.time}</p>
                      </div>
                      <p className="mt-1 text-sm font-black">{event.title}</p>
                      {event.detail ? (
                        <p className="mt-1 break-words text-xs leading-5 text-[#51483f]">
                          {event.detail}
                        </p>
                      ) : null}
                    </article>
                  ))}
                </div>
              </div>
            </aside>
          </div>
        </section>
      </section>
    </main>
  );
}
