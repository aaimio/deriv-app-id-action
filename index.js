/* eslint-disable no-async-promise-executor */
const core = require('@actions/core');
const github = require('@actions/github');
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
                authorize: core.getInput('DERIV_API_TOKEN'),
            });

            if (!authorise) return resolve(false);

            log('Done authorising.\n');
            resolve(authorise);
        });
    }

    createApp(app_options) {
        return new Promise(async (resolve) => {
            log('Unable to find recyclable App ID. Generating new one...');
            log('App options', { ...app_options });

            const app_register = await this.resolveApiRequest('appRegister', {
                app_register: 1,
                ...app_options,
            });
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

            // eslint-disable-next-line no-constant-condition
            while (true) {
                try {
                    const current_pull_requests = await octokit.pulls.list({
                        ...github.context.repo,
                        state: 'open',
                        per_page: 100,
                        page: current_page,
                    });

                    if (current_pull_requests.data.length) {
                        pull_requests.push(...current_pull_requests.data);
                        current_page++;
                        continue;
                    }

                    pull_requests.forEach((pull_request) => log(`- ${pull_request.html_url}`));
                    log(`Done retrieving ${pull_requests.length} open pull requests.\n`);
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

    async runAction() {
        return new Promise(async (resolve, reject) => {
            const { issue } = github.context.payload;
            const preview_url = core.getInput('vercel_preview_url');
            const deriv_app_id = Number(core.getInput('DERIV_APP_ID'));

            const open_pull_requests = await this.getOpenPullRequests();
            if (!open_pull_requests) return reject();

            const websocket = new WebSocket(
                `wss://frontend.binaryws.com/websockets/v3?app_id=${deriv_app_id}&brand=deriv&lang=EN`
            );

            websocket.addEventListener('error', warn);

            this.api = new DerivAPI({ app_id: deriv_app_id, connection: websocket });

            const authorise = await this.authorise();
            if (!authorise) return reject();

            const apps = await this.getCreatedApps();
            if (!apps) return reject();

            // In the case where the preview URL has been updated to a different URL
            // (i.e. when Vercel pulls a magic trick: https://github.com/vercel/vercel/discussions/5271),
            // re-use the App ID and update the redirect_uri for existing app (if any).
            const app_to_recycle = apps.find(
                (app) => app.github === issue.pull_request.html_url && app.redirect_uri !== preview_url
            );

            if (!app_to_recycle) {
                // Check if we already have an App ID for this PR + redirect_uri, if so, don't do anything.
                // We assume that this action already posted a comment. This will always be the case unless
                // the App IDs are managed outside of this action (e.g. manual updating of some apps).
                const existing_app = apps.find(
                    (app) => app.github === issue.pull_request.html_url && app.redirect_uri === preview_url
                );

                if (existing_app) {
                    log(
                        'There was an existing App ID for this URL. No action will be taken as a comment should have already been posted.\n'
                    );

                    core.setOutput('pr_url', issue.pull_request.html_url);
                    core.setOutput('pr_number', issue.number);
                    core.setOutput('app_id', existing_app.app_id);
                    core.setOutput('should_post_comment', false);

                    resolve();
                }
            }

            // A recyclable app is a Deriv App which has a link in its `github` field that isn't
            // part of the `open_pull_requests_urls` array.
            const getRecyclableApp = () => {
                const open_pull_requests_urls = open_pull_requests.map((pr) => pr.html_url);
                return apps.find((app) => app.github && !open_pull_requests_urls.includes(app.github));
            };

            const existing_app = app_to_recycle || getRecyclableApp();
            const stripped_app_title = issue.title.replace(/[^A-Za-z0-9 ]/g, '').substring(0, 35);
            const app_options = {
                name: `${stripped_app_title} PR${issue.number}`,
                redirect_uri: preview_url,
                github: issue.pull_request.html_url,
                scopes: ['read', 'trade', 'trading_information', 'payments', 'admin'],
            };

            const app = existing_app
                ? await this.updateApp(existing_app.app_id, app_options)
                : await this.createApp(app_options);

            if (!app) return reject();

            core.setOutput('pr_url', issue.pull_request.html_url);
            core.setOutput('pr_number', issue.number);
            core.setOutput('app_id', app.app_id);
            core.setOutput('should_post_comment', true);

            resolve();
        });
    }

    updateApp(app_id, app_options) {
        return new Promise(async (resolve) => {
            log(`Attempting to recycle App ID ${app_id}...`);
            log('App options', { app_id, ...app_options });

            const app_update = await this.resolveApiRequest('appUpdate', {
                app_update: app_id,
                ...app_options,
            });
            if (!app_update) return resolve(false);

            log(`Done recycling App ID ${app_id}. Stay green!\n`);
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
        } catch (e) {
            warn(`An error occured retrying (${i}/${max_retries})...`);
        }
    }

    core.setFailed('Exceeded maximum amount of retries. Aborting.');
    process.exit(1);
})();
