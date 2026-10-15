import { URL_ENV } from './http.js';

// Static text on purpose: the exact wording is part of the CLI's contract.
export const HELP = `
open-taskboard CLI

  taskboard serve [--host H] [--port P] [--data-dir D]   start the board + API
  taskboard project create --id ID --name NAME [--workspace-path PATH]
  taskboard project list
  taskboard project delete ID [--yes]
  taskboard issue create --project ID --title T [--parent PARENT_ID]
        [--status todo|in_progress|in_review|done] [--priority urgent|high|medium|low]
        [--labels a,b] [--branch BRANCH] [--assignee WHO] [--description TEXT]
  taskboard issue list --project ID [--status S] [--parent ID|null]
  taskboard issue show ID
  taskboard issue update ID [--title T] [--status S] [--priority P] [--branch B]
        [--labels L] [--assignee W] [--description TEXT] [--expected-version N]
  taskboard issue done ID [--expected-version N]
  taskboard issue delete ID
  taskboard comment add ID [--author WHO] [--body TEXT]
  taskboard comment list ID
  taskboard progress --project ID

Env: ${URL_ENV} to point at another host (e.g. LAN teammate's board).
`;
