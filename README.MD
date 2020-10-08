# Overview

Enabling this action on your repository will automatically generate Deriv.app production App IDs for any PRs opened to your target branch (specified in your workflow, see `.github/workflows/example.yml`).

**Please ensure you're using a dedicated Deriv API token for this**

- To generate a new token, visit https://app.deriv.com/account/api-token.

## How it works

The action retrieves all open PRs for the installed repository, it will then compare this list with the created apps on Deriv. If any of the apps has a `github_url` which no longer points to an open PR, it will be recycled.

- You may find an example workflow in the `.github/workflows` folder.

### Inputs

- `DERIV_API_TOKEN`: The Deriv token to be used to generate App IDs. Please use a dedicated token. See https://app.deriv.com/account/api-token (pass as GitHub secret!)
- `deriv_app_id`: The App ID to be used with Deriv API to identify the API connection to Deriv.
- `GITHUB_TOKEN`: The GitHub token to be used with Octokit to identify the API connection to GitHub.
- `max_retries` (optional): Amount of times to retry in case of error(s) (default: `5`).
- `vercel_preview_url`: The Vercel deployment URL to generate an App ID for.

### Outputs

- `pr_url`: The URL of the GitHub pull request.
- `app_id`: The newly created or updated Deriv App ID.
- `should_post_comment`: Signals the next step whether to post a comment or not.

## Development

All of the logic is in a single file (`index.js`). After making changes to the file run `npm run build` to compile `dist/index.js` and all `node_modules` into a single JS file (it'll be placed in `dist/index.js`).