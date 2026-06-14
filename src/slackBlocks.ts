import type { DraftTask } from "./taskParser.js";
import type { LearningSuggestion } from "./adminSettings.js";
import type { MessageDraft } from "./proposals.js";

export function proposalBlocks(draft: DraftTask, proposalId: string) {
  const fields = [
    `*Title*\n${draft.title}`,
    `*Priority*\n${formatPriority(draft.priority)}`,
    `*Due*\n${draft.dueDate ? new Date(draft.dueDate).toDateString() : "Not set"}`,
    `*Assignees*\n${draft.assigneeNames.length ? draft.assigneeNames.join(", ") : "Not set"}`,
    `*Client / List*\n${draft.targetListName ?? "Default fallback list"}`,
    `*Category*\n${draft.category ?? "General"}`,
    `*Sync path*\n${draft.targetListName || draft.workbookUrl ? "SEO workbook -> ClickUp sync" : "Direct ClickUp fallback"}`
  ];

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Task proposal ready for approval*"
      }
    },
    {
      type: "section",
      fields: fields.map((text) => ({ type: "mrkdwn", text }))
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Description*\n${draft.description}`
      }
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve" },
          style: "primary",
          action_id: "approve_task",
          value: proposalId
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Reject" },
          style: "danger",
          action_id: "reject_task",
          value: proposalId
        }
      ]
    }
  ];
}

export function learningBlocks(suggestion: LearningSuggestion) {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          "*Should I remember this?*",
          suggestion.text
        ].join("\n")
      }
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Remember" },
          style: "primary",
          action_id: "approve_learning",
          value: suggestion.id
        },
        {
          type: "button",
          text: { type: "plain_text", text: "No" },
          style: "danger",
          action_id: "reject_learning",
          value: suggestion.id
        }
      ]
    }
  ];
}

export function messageProposalBlocks(draft: MessageDraft, proposalId: string) {
  const targets = draft.targets?.length
    ? draft.targets.map((target) => target.kind === "dm" ? target.channelName : `#${target.channelName}`).join(", ")
    : `#${draft.channelName}`;
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Slack message ready for approval*"
      }
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Target${draft.targets && draft.targets.length > 1 ? "s" : ""}*\n${targets}` },
        { type: "mrkdwn", text: "*Action*\nSend message" }
      ]
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Message*\n${draft.text}`
      }
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Send" },
          style: "primary",
          action_id: "approve_task",
          value: proposalId
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Edit" },
          action_id: "edit_message_proposal",
          value: proposalId
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Trust Route" },
          action_id: "trust_message_proposal",
          value: proposalId
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Cancel" },
          style: "danger",
          action_id: "reject_task",
          value: proposalId
        }
      ]
    }
  ];
}

function formatPriority(priority: DraftTask["priority"]): string {
  if (priority === 1) return "Urgent";
  if (priority === 2) return "High";
  if (priority === 3) return "Normal";
  if (priority === 4) return "Low";
  return "Not set";
}
