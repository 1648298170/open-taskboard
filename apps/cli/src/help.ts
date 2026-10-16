import { URL_ENV } from './http.js';

// Static text on purpose: the exact wording is part of the CLI's contract.
export const HELP = `
open-taskboard CLI

  taskboard serve [--host H] [--port P] [--data-dir D]   start the board + API
  taskboard project create --id ID --name NAME [--workspace-path PATH]
  taskboard project list
  taskboard project refs ID
  taskboard project delete ID [--yes]
  taskboard issue create --project ID --title T [--parent PARENT_ID]
        [--template NAME] [--status todo|in_progress|in_review|done]
        [--priority urgent|high|medium|low]
        [--labels a,b] [--branch BRANCH] [--worktree W] [--assignee WHO] [--description TEXT]
        [--start-date YYYY-MM-DD] [--due-date YYYY-MM-DD]
  taskboard issue list --project ID [--status S] [--parent ID|null] [--archived]
  taskboard issue show ID
  taskboard issue dep-add ID --on DEPENDS_ON_ID
  taskboard issue dep-rm ID --on DEPENDS_ON_ID
  taskboard issue dep-list ID
  taskboard issue update ID [--title T] [--status S] [--priority P] [--branch B] [--worktree W]
        [--labels L] [--assignee W] [--description TEXT]
        [--start-date YYYY-MM-DD] [--due-date YYYY-MM-DD] [--expected-version N]
  taskboard issue done ID [--expected-version N]
  taskboard issue delete ID
  taskboard issue archive ID
  taskboard issue unarchive ID
  taskboard issue claim ID --agent NAME [--ttl MIN]
  taskboard issue heartbeat ID --agent NAME
  taskboard issue release ID --agent NAME
  taskboard issue attachments ID
  taskboard issue attach ID FILE
  taskboard comment add ID [--author WHO] [--body TEXT]
  taskboard comment list ID
  taskboard progress --project ID
  taskboard stats --project ID [--weeks 8]
  taskboard next --project ID [--assignee WHO] [--agent WHO]
  taskboard ready --project ID [--assignee WHO] [--agent WHO]
  taskboard search QUERY
  taskboard export [--project ID] [--format json|md] [--out FILE]
  taskboard templates

Env: ${URL_ENV} to point at another host (e.g. LAN teammate's board).
`;
