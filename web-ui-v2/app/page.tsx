"use client";

import { useEffect, useRef, useState } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent } from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputBody,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputTools,
  PromptInputSubmit,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import { Loader } from "@/components/ai-elements/loader";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { SparklesIcon, MoonIcon, SunIcon } from "lucide-react";
import { Streamdown } from "streamdown";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  tool?: string;
  status?: "pending" | "streaming" | "done" | "error";
};

type Tool = {
  name: string;
  description?: string;
};

const QUICK_TOOLS = [
  { value: "council", label: "Council", hint: "All providers debate" },
  { value: "ask_all_ais", label: "All AIs", hint: "Fan out to every provider" },
  { value: "smart_query", label: "Smart", hint: "Auto-route best provider" },
  { value: "compare_ais", label: "Compare", hint: "Side-by-side answers" },
  { value: "chain_query", label: "Chain", hint: "Multi-step pipeline" },
  { value: "ask_chatgpt", label: "ChatGPT", hint: "OpenAI only" },
  { value: "ask_claude", label: "Claude", hint: "Anthropic only" },
  { value: "ask_gemini", label: "Gemini", hint: "Google only" },
  { value: "ask_perplexity", label: "Perplexity", hint: "With sources" },
  { value: "ask_deepseek", label: "DeepSeek", hint: "Reasoning model" },
  { value: "ask_qwen", label: "Qwen", hint: "Alibaba" },
  { value: "ask_zai", label: "Z.AI", hint: "GLM" },
  { value: "ask_minimax", label: "MiniMax", hint: "Long context" },
  { value: "ask_kimi", label: "Kimi", hint: "Moonshot" },
  { value: "ask_mimo", label: "MiMo", hint: "Xiaomi" },
];

const EXTRA_VISIBLE = new Set([
  "deep_search", "internet_search", "news_search", "academic_search",
  "generate_article", "generate_code", "review_code", "explain_code",
  "optimize_code", "fact_check", "brainstorm", "solve", "verify",
  "debate", "how_to", "writing_help", "summarize_url", "fix_error",
  "explain_error", "convert_code", "build_architecture", "write_tests",
  "security_audit", "compare", "find_stats",
]);

export default function ChatPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [tool, setTool] = useState("council");
  const [pending, setPending] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [allTools, setAllTools] = useState<Tool[]>([]);
  const idRef = useRef(0);

  // Load tools list once
  useEffect(() => {
    fetch("/api/tools")
      .then((r) => r.json())
      .then((d) => setAllTools(d.tools ?? []))
      .catch(() => {});
  }, []);

  // Theme toggle
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
  }, [theme]);

  // Initial theme from system preference
  useEffect(() => {
    if (typeof window !== "undefined") {
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      setTheme(prefersDark ? "dark" : "light");
    }
  }, []);

  const handleSubmit = async (msg: PromptInputMessage) => {
    const text = msg.text?.trim() ?? "";
    if (!text || pending) return;

    const userId = `m${++idRef.current}`;
    const asstId = `m${++idRef.current}`;

    setMessages((prev) => [
      ...prev,
      { id: userId, role: "user", content: text, tool },
      { id: asstId, role: "assistant", content: "", tool, status: "pending" },
    ]);
    setPending(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool, message: text }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Request failed");

      const responseText = data.text || "";
      const { reasoning, summary } = splitReasoning(responseText);

      setMessages((prev) =>
        prev.map((m) =>
          m.id === asstId
            ? {
                ...m,
                content: summary,
                reasoning,
                status: "done",
              }
            : m,
        ),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Request failed";
      setMessages((prev) =>
        prev.map((m) =>
          m.id === asstId
            ? { ...m, content: `**Error:** ${message}`, status: "error" }
            : m,
        ),
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground antialiased">
      {/* Header */}
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-border/60 bg-background/80 px-6 py-3 backdrop-blur-md">
        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-md bg-foreground text-background">
            <SparklesIcon className="size-4" />
          </div>
          <span className="font-semibold tracking-tight">Proxima</span>
          <span className="ml-2 hidden text-xs text-muted-foreground sm:inline">
            Multi-provider AI
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          aria-label="Toggle theme"
        >
          {theme === "dark" ? (
            <SunIcon className="size-4" />
          ) : (
            <MoonIcon className="size-4" />
          )}
        </Button>
      </header>

      {/* Conversation */}
      <Conversation className="flex-1">
        <ConversationContent className="mx-auto w-full max-w-3xl px-4 py-6">
          {messages.length === 0 ? (
            <ConversationEmptyState
              icon={<SparklesIcon className="size-8" />}
              title="Ready when you are"
              description="Pick a tool below and ask anything. Proxima fans out to every provider."
            />
          ) : (
            messages.map((m) => (
              <Message key={m.id} from={m.role} className="px-0">
                <MessageContent>
                  {m.role === "assistant" ? (
                    m.status === "pending" ? (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader />
                        <span>Asking {m.tool}…</span>
                      </div>
                    ) : (
                      <>
                        {m.reasoning && (
                          <Reasoning className="mb-3" defaultOpen={false}>
                            <ReasoningTrigger />
                            <ReasoningContent>{m.reasoning}</ReasoningContent>
                          </Reasoning>
                        )}
                        <Streamdown className="prose prose-sm max-w-none dark:prose-invert">
                          {m.content || "_(empty)_"}
                        </Streamdown>
                      </>
                    )
                  ) : (
                    <span>{m.content}</span>
                  )}
                </MessageContent>
              </Message>
            ))
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      {/* Prompt Input */}
      <div className="mx-auto w-full max-w-3xl px-4 pb-6">
        <PromptInput onSubmit={handleSubmit}>
          <PromptInputBody>
            <PromptInputTextarea
              placeholder={getPlaceholder(tool)}
              disabled={pending}
            />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools>
              <Select value={tool} onValueChange={setTool}>
                <SelectTrigger className="h-7 gap-1.5 border-0 bg-transparent px-2 text-xs font-medium text-muted-foreground hover:text-foreground focus:ring-0 focus-visible:ring-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="start">
                  {QUICK_TOOLS.map((t) => (
                    <SelectItem key={t.value} value={t.value} className="text-xs">
                      <span className="font-medium">{t.label}</span>
                      <span className="ml-2 text-muted-foreground">{t.hint}</span>
                    </SelectItem>
                  ))}
                  {allTools
                    .filter(
                      (t) =>
                        !QUICK_TOOLS.find((q) => q.value === t.name) &&
                        EXTRA_VISIBLE.has(t.name),
                    )
                    .map((t) => (
                      <SelectItem key={t.name} value={t.name} className="text-xs">
                        <span className="font-medium capitalize">
                          {t.name.replace(/_/g, " ")}
                        </span>
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </PromptInputTools>
            <PromptInputSubmit disabled={pending} status={pending ? "streaming" : undefined} />
          </PromptInputFooter>
        </PromptInput>
        <p className="mt-2 text-center text-[11px] text-muted-foreground">
          Proxima can make mistakes. Verify important info.
        </p>
      </div>
    </div>
  );
}

function getPlaceholder(tool: string): string {
  switch (tool) {
    case "compare":
      return "Compare two things — use 'a | b' format";
    case "council":
      return "Ask anything — all providers will weigh in";
    case "ask_all_ais":
      return "Fan out to every provider";
    case "smart_query":
      return "Ask anything — Proxima picks the best provider";
    case "compare_ais":
      return "Get side-by-side answers from all providers";
    case "chain_query":
      return "Multi-step query — chained across providers";
    case "generate_article":
      return "Topic for a long-form article";
    case "generate_code":
      return "Describe what code to generate";
    case "fact_check":
      return "Claim to fact-check";
    case "brainstorm":
      return "Topic to brainstorm";
    case "solve":
      return "Problem to solve";
    case "verify":
      return "Question to verify across providers";
    case "deep_search":
      return "Deep web search query";
    case "internet_search":
      return "Quick web search";
    default:
      if (tool.startsWith("ask_")) {
        const provider = tool.replace("ask_", "");
        return `Ask ${provider} directly`;
      }
      return "Type your message…";
  }
}

// Split MCP response into reasoning (per-provider) and summary (aggregate).
function splitReasoning(text: string): { reasoning?: string; summary: string } {
  if (!text) return { summary: "" };

  // Try to find the aggregate / summary marker
  const markers = [
    /─{3,}\s*AGGREGATE/i,
    /^##\s*Summary/im,
    /^##\s*Synthesis/im,
    /\*\*Kesimpulan\*\*/i,
    /^##\s*Final/im,
  ];

  for (const re of markers) {
    const m = re.exec(text);
    if (m && m.index > 200) {
      const reasoning = text.slice(0, m.index).trim();
      const summary = text.slice(m.index).trim();
      return { reasoning, summary };
    }
  }

  return { summary: text };
}
