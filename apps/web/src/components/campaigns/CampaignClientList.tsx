import type { CampaignBoard } from "@t3tools/contracts";
import { PencilIcon, PlusIcon } from "lucide-react";

import { needsApprovalCount } from "./campaigns.logic";

/**
 * Every client with its campaigns. A count beside a campaign says how many posts wait for approval.
 * Adding and editing are for administrators; others see the list only.
 */
export function CampaignClientList({
  board,
  selectedCampaignId,
  isAdministrator,
  onSelect,
  onEditClient,
  onNewCampaign,
}: {
  readonly board: Pick<CampaignBoard, "clients" | "campaigns">;
  readonly selectedCampaignId: string | null;
  readonly isAdministrator: boolean;
  readonly onSelect: (campaignId: string) => void;
  readonly onEditClient: (clientId: string) => void;
  readonly onNewCampaign: (clientId: string) => void;
}) {
  return (
    <nav aria-label="Clients and campaigns" className="flex flex-col gap-4">
      {board.clients.map((client) => {
        const campaigns = board.campaigns.filter((campaign) => campaign.clientId === client.id);
        return (
          <section key={client.id} aria-label={client.name} className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2">
              <h3 className="min-w-0 truncate text-xs font-medium text-muted-foreground">
                {client.name}
              </h3>
              {isAdministrator ? (
                <button
                  type="button"
                  data-wb-cp-icon=""
                  aria-label={`Edit ${client.name}`}
                  onClick={() => onEditClient(client.id)}
                >
                  <PencilIcon className="size-3.5" aria-hidden />
                </button>
              ) : null}
            </div>
            <ul className="flex flex-col gap-0.5">
              {campaigns.map((campaign) => {
                const waiting = needsApprovalCount(campaign);
                return (
                  <li key={campaign.id}>
                    <button
                      type="button"
                      data-wb-cp-row=""
                      aria-current={campaign.id === selectedCampaignId ? "true" : undefined}
                      onClick={() => onSelect(campaign.id)}
                    >
                      <span className="min-w-0 flex-1 truncate">{campaign.name}</span>
                      {waiting > 0 ? (
                        <span data-wb-count="">
                          {waiting}
                          <span className="sr-only"> Waiting For Approval</span>
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
              {campaigns.length === 0 ? (
                <li className="px-3 py-1 text-xs text-muted-foreground">No campaigns yet</li>
              ) : null}
              {isAdministrator ? (
                <li>
                  <button type="button" data-wb-cp-row="" onClick={() => onNewCampaign(client.id)}>
                    <PlusIcon className="size-3.5" aria-hidden />
                    <span>New Campaign</span>
                  </button>
                </li>
              ) : null}
            </ul>
          </section>
        );
      })}
    </nav>
  );
}
