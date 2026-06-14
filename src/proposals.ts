import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DraftTask } from "./taskParser.js";
import { config } from "./config.js";

export type MessageDraft = {
  channelId: string;
  channelName: string;
  isMember?: boolean;
  isPrivate?: boolean;
  text: string;
  targets?: MessageTarget[];
};

export type MessageTarget = {
  channelId: string;
  channelName: string;
  isMember?: boolean;
  isPrivate?: boolean;
  kind?: "channel" | "dm";
};

type ProposalBase = {
  id: string;
  channel: string;
  messageTs: string;
  requester: string;
  status: "pending" | "approving" | "approved" | "rejected";
};

export type TaskProposal = ProposalBase & {
  kind: "task";
  draft: DraftTask;
};

export type MessageProposal = ProposalBase & {
  kind: "message";
  message: MessageDraft;
};

export type Proposal = TaskProposal | MessageProposal;

const proposalsById = new Map<string, Proposal>();
const proposalsByMessage = new Map<string, string>();
const proposalsPath = join(config.DATA_DIR, "proposals.json");

loadPersistedProposals();

export function createProposal(input: Omit<TaskProposal, "id" | "status" | "kind">): TaskProposal {
  const proposal: Proposal = {
    ...input,
    kind: "task",
    id: randomUUID(),
    status: "pending"
  };

  proposalsById.set(proposal.id, proposal);
  proposalsByMessage.set(messageKey(proposal.channel, proposal.messageTs), proposal.id);
  persistProposals();
  return proposal;
}

export function createMessageProposal(input: Omit<MessageProposal, "id" | "status" | "kind">): MessageProposal {
  const proposal: Proposal = {
    ...input,
    kind: "message",
    id: randomUUID(),
    status: "pending"
  };

  proposalsById.set(proposal.id, proposal);
  proposalsByMessage.set(messageKey(proposal.channel, proposal.messageTs), proposal.id);
  persistProposals();
  return proposal;
}

export function getProposal(id: string): Proposal | undefined {
  return proposalsById.get(id);
}

export function getProposalByMessage(channel: string, messageTs: string): Proposal | undefined {
  const id = proposalsByMessage.get(messageKey(channel, messageTs));
  return id ? proposalsById.get(id) : undefined;
}

export function updateProposalStatus(id: string, status: Proposal["status"]): Proposal | undefined {
  const proposal = proposalsById.get(id);
  if (!proposal) return undefined;

  proposal.status = status;
  persistProposals();
  return proposal;
}

export function beginProposalApproval(id: string): Proposal | undefined {
  const proposal = proposalsById.get(id);
  if (!proposal || proposal.status !== "pending") return undefined;

  proposal.status = "approving";
  persistProposals();
  return proposal;
}

function loadPersistedProposals() {
  if (!existsSync(proposalsPath)) return;

  try {
    const parsed = JSON.parse(readFileSync(proposalsPath, "utf8")) as Proposal[];
    if (!Array.isArray(parsed)) return;

    for (const proposal of parsed) {
      if (!isProposal(proposal)) continue;
      const restored = proposal.status === "approving"
        ? { ...proposal, status: "pending" as const }
        : proposal;
      proposalsById.set(restored.id, restored);
      proposalsByMessage.set(messageKey(restored.channel, restored.messageTs), restored.id);
    }
  } catch {
    // Ignore corrupt persistence so Viktor can still start.
  }
}

function persistProposals() {
  mkdirSync(config.DATA_DIR, { recursive: true });
  const proposals = [...proposalsById.values()].slice(-250);
  writeFileSync(proposalsPath, JSON.stringify(proposals, null, 2));
}

function isProposal(value: unknown): value is Proposal {
  if (!value || typeof value !== "object") return false;
  const proposal = value as Partial<Proposal>;
  return typeof proposal.id === "string" &&
    typeof proposal.channel === "string" &&
    typeof proposal.messageTs === "string" &&
    typeof proposal.requester === "string" &&
    ["pending", "approving", "approved", "rejected"].includes(String(proposal.status)) &&
    (proposal.kind === "task" || proposal.kind === "message");
}

function messageKey(channel: string, ts: string): string {
  return `${channel}:${ts}`;
}
