const core = require('@actions/core');
const github = require('@actions/github');
// Use below over github.getOctokit() cause it auto-handles authentication.
const { Octokit } = require('@octokit/action');
const DerivAPI = require('@deriv/deriv-api/dist/DerivAPIBasic');
const WebSocket = require('ws');

const log = (...args) => console.log(...args);
const warn = (...args) => console.warn(...args);

class AppIdGenerator {
    authorise() {
        return new Promise(async (resolve) => {
            log('Authorising...');

            const authorise = await this.resolveApiRequest('authorize', {
                authorize: core.getInput('deriv_api_token'),
            });
            if (!authorise) return resolve(false);

            log('Done authorising.\n');
            resolve(authorise);
        });
    }

    createApp(app_options) {
        return new Promise(async (resolve) => {
            log('Unable to find reusable App ID. Generating new one...');
            log('App options', { ...app_options });

            const app_register = await this.resolveApiRequest('appRegister', { app_register: 1, ...app_options });
            if (!app_register) return resolve(false);

            log(`Done generating App ID (${app_register.app_id}).\n`);
            resolve(app_register);
        });
    }

    getCreatedApps() {
        return new Promise(async (resolve) => {
            log('Retrieving existing App IDs...');

            const apps = await this.resolveApiRequest('appList', { app_list: 1 });
            if (!apps) return resolve(false);

            apps.forEach((app) => {
                if (app.github) {
                    log(`> ${app.redirect_uri} (${app.app_id})`);
                }
            });

            log('Done retrieving App IDs.\n');
            resolve(apps);
        });
    }

    getOpenPullRequests() {
        return new Promise(async (resolve) => {
            log('Retrieving open pull requests...');

            const octokit = new Octokit({ userAgent: 'App ID Generator' });
            const pull_requests = [];
            let current_page = 1;

            while (true) {
                try {
                    const current_pull_requests = await octokit.pulls.list({
                        ...github.context.repo,
                        state: 'open',
                        per_page: 100,
                        page: current_page,
                    });

                    if (current_pull_requests.length) {
                        pull_requests.push(...current_pull_requests);
                        current_page++;
                        continue;
                    }

                    pull_requests.forEach((pull_request) => log(pull_request));
                    log('Done retrieving open pull requests.\n');
                    resolve(pull_requests);
                    break;
                } catch (error) {
                    warn(error);
                    resolve(false);
                    break;
                }
            }
        });
    }

    resolveApiRequest(request, payload = {}) {
        return new Promise((resolve) => {
            this.api[request](payload)
                .then((response) => {
                    resolve(response[response.msg_type]);
                })
                .catch((error) => {
                    warn(`${error.error.message} (${error.error.code})`);
                    resolve(false);
                });
        });
    }

    // Async so logs are shown.
    async runAction() {
        return new Promise(async (resolve, reject) => {
            const { comment, issue } = github.context.payload;

            if (issue.user.login !== core.getInput('accept_edits_from_user')) {
                log('Incorrect user. No action should be taken.\n');
                return resolve();
            }

            const regexp = new RegExp(core.getInput('preview_url_regexp'));
            const matches = comment.body.match(regexp);

            if (!matches) {
                log(
                    `Could not find any preview URLs with regular expression (${core.getInput(
                        'preview_url_regexp'
                    )}). Aborting.\n`
                );
                return resolve();
            }

            const stripped_title = issue.title.replace(/[^A-Za-z0-9 ]/g, '').substring(0, 35);
            const preview_url = matches[1];
            const app_options = {
                name: `${stripped_title} PR${issue.number}`,
                redirect_uri: preview_url,
                github: issue.pull_request.html_url,
                scopes: ['read', 'trade', 'trading_information', 'payments', 'admin'],
            };

            const open_pull_requests = await this.getOpenPullRequests();
            if (!open_pull_requests) return reject();

            this.api = new DerivAPI({
                app_id: 1,
                connection: new WebSocket('wss://frontend.binaryws.com/websockets/v3?app_id=1&brand=deriv&lang=EN'),
            });

            const authorise = await this.authorise();
            if (!authorise) return reject();

            const apps = await this.getCreatedApps();
            if (!apps) return reject();

            // Check whether there is an existing App ID for this redirect_uri. If so
            // inform consumer. TODO: Update this PR with the App ID.
            const existing_app = apps.find((app) => app.redirect_uri === preview_url);

            if (existing_app) {
                log('There was an existing App ID for this URL. Aborting.\n');
                return resolve();
            }

            // Check whether any of the GitHub URLs specified in our app list isn't
            // in the current open PRs list.
            const open_pull_requests_urls = open_pull_requests.map((pr) => pr.html_url);
            const expired_app = apps.find((app) => {
                if (!app.github) return false;
                return !open_pull_requests_urls.includes(app.github);
            });

            const app = expired_app
                ? await this.updateApp(expired_app.app_id, app_options)
                : await this.createApp(app_options);

            if (!app) return reject();

            core.setOutput('pr_url', issue.pull_request.html_url);
            core.setOutput('preview_url', preview_url);
            core.setOutput('app_id', app.app_id);
            core.setOutput('should_post_comment', true);

            resolve();
        });
    }

    updateApp(app_id, app_options) {
        return new Promise(async (resolve) => {
            log(`Attempting to update App ID ${app_id}...`);
            log('App options', { app_id, ...app_options });

            const app_update = await this.resolveApiRequest('appUpdate', { app_update: app_id, ...app_options });
            if (!app_update) return resolve(false);

            log(`Done updating App ID ${app_id}\n`);
            resolve(app_update);
        });
    }
}

(async () => {
    const max_retries = core.getInput('max_retries');

    for (let i = 1; i <= max_retries; i++) {
        try {
            const generator = new AppIdGenerator();
            await generator.runAction();
            process.exit(0);
        } catch {
            warn(`An error occured retrying (${i}/${max_retries})...`);
        }
    }

    core.setFailed('Exceeded maximum amount of retries. Aborting.');
    process.exit(1);
})();
