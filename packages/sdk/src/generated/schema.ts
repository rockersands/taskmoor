// Generated from docs/api/openapi.json by packages/sdk/src/generate.ts. Do not edit.
export interface paths {
    "/api/meta": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * What this instance is and which clients it works with
         * @description Needs no sign-in and holds no secret: the backend and API versions, the frontend versions it serves, how people sign in, and the instance’s id and public key. With a nonce, the instance signs it, so a client can check it reached the instance it expects.
         */
        get: operations["getMeta"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/property-indexes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The declared property indexes
         * @description For site and configuration administrators.
         */
        get: operations["listPropertyIndexes"];
        put?: never;
        /**
         * Make a value inside ticket properties searchable
         * @description Declares that the values found at `path` inside the `key` property of tickets are of `type`, and fills the index from the properties already set. Queries then read them as `ticket.property[key].path`, or by the `alias`. An array along the path gives one value per element; a value of another type is left out. For site and configuration administrators.
         */
        post: operations["createPropertyIndex"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/property-indexes/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Drop a property index
         * @description The properties stay; queries can no longer read the values.
         */
        delete: operations["deletePropertyIndex"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/boards": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The boards the caller may see */
        get: operations["listBoards"];
        put?: never;
        /** Make a board from a query */
        post: operations["createBoard"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/boards/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read a board’s configuration */
        get: operations["getBoard"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/boards/{id}/backlog": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** A Scrum board’s open sprints and backlog */
        get: operations["getBacklog"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/boards/{id}/data": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** A board’s columns, lanes and cards */
        get: operations["getBoardCards"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/boards/{id}/properties": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The property keys of a board */
        get: operations["listBoardProperties"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/boards/{id}/properties/{key}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** One property of a board */
        get: operations["getBoardProperty"];
        /**
         * Set a property of a board
         * @description Sets the key to any JSON value of at most 32,768 bytes as JSON text, replacing what was there. Reading needs the right to see the board; writing, the right to configure it.
         */
        put: operations["setBoardProperty"];
        post?: never;
        /** Delete a property of a board */
        delete: operations["deleteBoardProperty"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/boards/{id}/sprints": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** A Scrum board’s sprints */
        get: operations["listSprints"];
        put?: never;
        /** Plan a sprint */
        post: operations["createSprint"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/bulk-operations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The caller’s latest bulk changes */
        get: operations["listBulkOperations"];
        put?: never;
        /**
         * Start a bulk change
         * @description Transitions, moves, edits or deletes many tickets as one task, given as ids or keys or as a query whose results are the tickets. Each ticket goes through the same checks as a change of its own. The workspace limits how many tickets one operation may change (10,000 by default, the `tickets_per_bulk_operation` guardrail).
         */
        post: operations["createBulkOperation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/bulk-operations/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * A bulk change’s progress
         * @description Readable for 14 days after it finishes.
         */
        get: operations["getBulkOperation"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/bulk-operations/{id}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Cancel the rest of a bulk change
         * @description Tickets already in hand finish; the ones not reached are skipped.
         */
        post: operations["cancelBulkOperation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/bulk-operations/{id}/items": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Each ticket’s result in a bulk change
         * @description In the order the tickets were given, a page at a time: pass the answer’s `next` as `after`. Filter by `outcome` to read only the failures, say.
         */
        get: operations["listBulkItems"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/fields": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The custom fields the caller may see */
        get: operations["listFields"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/link-types": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The kinds of link between tickets */
        get: operations["listLinkTypes"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/priorities": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The priorities, in order */
        get: operations["listPriorities"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/releases/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read a release */
        get: operations["getRelease"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/saved-searches": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The saved searches the caller owns or that are shared with them */
        get: operations["listSavedSearches"];
        put?: never;
        /** Save a search */
        post: operations["createSavedSearch"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/saved-searches/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read a saved search */
        get: operations["getSavedSearch"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/search": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Run a query, a page at a time
         * @description The query language of the search page. Pages follow `next`; the first page carries a count unless asked not to: exact up to 10,000, then an estimate within 10% (`approximate`) or a lower bound.
         */
        get: operations["search"];
        put?: never;
        /**
         * Run a query too long for a URL
         * @description The same as `GET /api/v1/search`, with the parameters in the body. It changes nothing.
         */
        post: operations["searchLong"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/search/check": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Check a query without running it */
        get: operations["checkQuery"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/session": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Who is calling
         * @description The signed-in person, and for a token its id and scopes.
         */
        get: operations["getSession"];
        put?: never;
        /**
         * Sign in with an email and a password
         * @description Starts a browser session (a cookie). Programs use API tokens instead; a second factor, when required, is asked for by the answer.
         */
        post: operations["signIn"];
        /** Sign out */
        delete: operations["signOut"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/sprints/{id}/complete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Complete a sprint
         * @description Its unfinished tickets go to the backlog, a future sprint or a new one.
         */
        post: operations["completeSprint"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/sprints/{id}/properties": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The property keys of a sprint */
        get: operations["listSprintProperties"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/sprints/{id}/properties/{key}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** One property of a sprint */
        get: operations["getSprintProperty"];
        /**
         * Set a property of a sprint
         * @description Sets the key to any JSON value of at most 32,768 bytes as JSON text, replacing what was there. Reading needs the right to see its board; writing, the right to manage its sprints.
         */
        put: operations["setSprintProperty"];
        post?: never;
        /** Delete a property of a sprint */
        delete: operations["deleteSprintProperty"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/sprints/{id}/start": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Start a sprint */
        post: operations["startSprint"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/sprints/{id}/tickets": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Move tickets into a sprint
         * @description From the backlog or another open sprint, in one operation.
         */
        post: operations["addSprintTickets"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/statuses": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The statuses, in order */
        get: operations["listStatuses"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tickets": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List tickets, a page at a time
         * @description For queries, use search; this lists a track’s tickets by rank.
         */
        get: operations["listTickets"];
        put?: never;
        /**
         * Make a ticket
         * @description In a track the caller may create tickets in; the track’s field rules apply.
         */
        post: operations["createTicket"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tickets/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read a ticket */
        get: operations["getTicket"];
        put?: never;
        post?: never;
        /** Move a ticket to the trash */
        delete: operations["deleteTicket"];
        options?: never;
        head?: never;
        /**
         * Change a ticket’s fields
         * @description Only the fields given change. Send `version` to be refused (409) if someone changed it since you read it.
         */
        patch: operations["updateTicket"];
        trace?: never;
    };
    "/api/v1/tickets/{id}/clone": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Copy a ticket, or a ticket and everything below it
         * @description Starts a task that copies the ticket, by default into its own track with its subtickets, attachments and links; each copy gets a Copies link to its original. With `descendants`, every ticket below it at every level is copied too (a deep clone). Values the caller may not set, or the track does not take, are left out. Poll the bulk operation it answers; each item names the copy it made.
         */
        post: operations["cloneTicket"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tickets/{id}/comments": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** A ticket’s comments, a page at a time */
        get: operations["listComments"];
        put?: never;
        /** Comment on a ticket */
        post: operations["addComment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tickets/{id}/comments/{commentId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Delete a comment */
        delete: operations["deleteComment"];
        options?: never;
        head?: never;
        /** Change a comment */
        patch: operations["updateComment"];
        trace?: never;
    };
    "/api/v1/tickets/{id}/history": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** A ticket’s changes, a page at a time */
        get: operations["getTicketHistory"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tickets/{id}/info": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** A ticket’s read-only info: first response, participants, time in status */
        get: operations["getTicketInfo"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tickets/{id}/links": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** A ticket’s links */
        get: operations["listLinks"];
        put?: never;
        /** Link a ticket to another */
        post: operations["addLink"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tickets/{id}/links/{linkId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Remove a link */
        delete: operations["removeLink"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tickets/{id}/properties": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The property keys of a ticket */
        get: operations["listTicketProperties"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tickets/{id}/properties/{key}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** One property of a ticket */
        get: operations["getTicketProperty"];
        /**
         * Set a property of a ticket
         * @description Sets the key to any JSON value of at most 32,768 bytes as JSON text, replacing what was there. Reading needs the right to see the ticket; writing, the right to edit it. The values of declared property indexes become searchable as `ticket.property[key].path`.
         */
        put: operations["setTicketProperty"];
        post?: never;
        /** Delete a property of a ticket */
        delete: operations["deleteTicketProperty"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tickets/{id}/rank": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Rank a ticket before or after another, or at an end */
        put: operations["rankTicket"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tickets/{id}/similar": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The tickets most similar in meaning to a ticket
         * @description Nearest first by the vectors of the bundled embedding model, which needs no AI provider or key; a ticket matches by its summary and description or by one of its comments. Only tickets the caller may see, and comments the caller may read, take part. Tickets changed in the last seconds may not be indexed yet.
         */
        get: operations["similarTickets"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tickets/{id}/time-entries": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Time logged on a ticket, a page at a time */
        get: operations["listTimeEntries"];
        put?: never;
        /** Log time on a ticket */
        post: operations["logTime"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tickets/{id}/transitions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The transitions a ticket may take now */
        get: operations["listTransitions"];
        put?: never;
        /**
         * Move a ticket through a transition
         * @description With the values its form asks for, such as a close reason.
         */
        post: operations["transitionTicket"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tickets/similar": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Tickets similar to a text being written
         * @description Duplicate suggestions while a ticket is created: the same lookup as `GET /api/v1/tickets/{id}/similar` for a text, optionally in one track. It changes nothing.
         */
        post: operations["similarToText"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tracks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List the tracks the caller may browse */
        get: operations["listTracks"];
        put?: never;
        /**
         * Make a track
         * @description Shared-mode tracks need a site or configuration administrator. A `template` adds its type, features and first board; `copyFrom` takes another shared track’s configuration.
         */
        post: operations["createTrack"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tracks/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read a track */
        get: operations["getTrack"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tracks/{id}/properties": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The property keys of a track */
        get: operations["listTrackProperties"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tracks/{id}/properties/{key}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** One property of a track */
        get: operations["getTrackProperty"];
        /**
         * Set a property of a track
         * @description Sets the key to any JSON value of at most 32,768 bytes as JSON text, replacing what was there. Reading needs the right to browse the track; writing, the right to administer it.
         */
        put: operations["setTrackProperty"];
        post?: never;
        /** Delete a property of a track */
        delete: operations["deleteTrackProperty"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tracks/{id}/releases": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** A track’s releases, in its order */
        get: operations["listReleases"];
        put?: never;
        /** Add a release to a track */
        post: operations["createRelease"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tracks/{id}/ticket-types": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The ticket types a track offers */
        get: operations["listTrackTicketTypes"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/users/{id}/properties": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The property keys of a user */
        get: operations["listUserProperties"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/users/{id}/properties/{key}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** One property of a user */
        get: operations["getUserProperty"];
        /**
         * Set a property of a user
         * @description Sets the key to any JSON value of at most 32,768 bytes as JSON text, replacing what was there. Only the person and site administrators read and write a person’s properties.
         */
        put: operations["setUserProperty"];
        post?: never;
        /** Delete a property of a user */
        delete: operations["deleteUserProperty"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        Backlog: {
            backlog: {
                tickets: ({
                    done: boolean;
                    id: number;
                    key: string;
                    status: {
                        id: number;
                        name: string;
                    } & {
                        [key: string]: unknown;
                    };
                    summary: string;
                } & {
                    [key: string]: unknown;
                })[];
                totals: {
                    estimate: number;
                    tickets: number;
                } & {
                    [key: string]: unknown;
                };
            } & {
                [key: string]: unknown;
            };
            sprints: ({
                boardId: number;
                completedAt: string | null;
                endAt: string | null;
                goal: string;
                id: number;
                name: string;
                sequence: number;
                startAt: string | null;
                startedAt: string | null;
                /** @enum {string} */
                state: "future" | "active" | "closed";
                tickets: ({
                    done: boolean;
                    id: number;
                    key: string;
                    status: {
                        id: number;
                        name: string;
                    } & {
                        [key: string]: unknown;
                    };
                    summary: string;
                } & {
                    [key: string]: unknown;
                })[];
                totals: {
                    estimate: number;
                    tickets: number;
                } & {
                    [key: string]: unknown;
                };
                version: number;
            } & {
                [key: string]: unknown;
            })[];
            truncated: boolean;
        } & {
            [key: string]: unknown;
        };
        Board: {
            columns: ({
                id: string;
                name: string;
                statusIds: number[];
            } & {
                [key: string]: unknown;
            })[];
            description: string;
            id: number;
            /** @enum {string} */
            kind: "scrum" | "kanban";
            /** @description Where the board lives: a track, or a person’s own space. */
            location: ({
                track: {
                    id: number;
                    key: string;
                    name: string;
                } & {
                    [key: string]: unknown;
                };
                /** @constant */
                type: "track";
            } & {
                [key: string]: unknown;
            }) | ({
                /** @constant */
                type: "user";
                user: {
                    id: number;
                    name: string | null;
                } & {
                    [key: string]: unknown;
                };
            } & {
                [key: string]: unknown;
            });
            name: string;
            /** @description The team the board belongs to, by its current name. */
            team: ({
                id: number;
                name: string;
            } & {
                [key: string]: unknown;
            }) | null;
            version: number;
        } & {
            [key: string]: unknown;
        };
        BoardData: {
            cards: ({
                columnId: string;
                id: number;
                key: string;
                laneId: string;
                rank: string;
                summary: string;
                version: number;
            } & {
                [key: string]: unknown;
            })[];
            columns: ({
                count: number;
                id: string;
                name: string;
            } & {
                [key: string]: unknown;
            })[];
            lanes: ({
                id: string;
                name: string;
            } & {
                [key: string]: unknown;
            })[];
            people: {
                assignees: {
                    id: number;
                    name: string;
                }[];
                more: boolean;
                unassigned: boolean;
                viewerId: number | null;
            };
            truncated: boolean;
        } & {
            [key: string]: unknown;
        };
        BoardSummary: {
            description: string;
            id: number;
            /** @enum {string} */
            kind: "scrum" | "kanban";
            /** @description Where the board lives: a track, or a person’s own space. */
            location: ({
                track: {
                    id: number;
                    key: string;
                    name: string;
                } & {
                    [key: string]: unknown;
                };
                /** @constant */
                type: "track";
            } & {
                [key: string]: unknown;
            }) | ({
                /** @constant */
                type: "user";
                user: {
                    id: number;
                    name: string | null;
                } & {
                    [key: string]: unknown;
                };
            } & {
                [key: string]: unknown;
            });
            name: string;
            /** @description The team the board belongs to, by its current name. */
            team: ({
                id: number;
                name: string;
            } & {
                [key: string]: unknown;
            }) | null;
        } & {
            [key: string]: unknown;
        };
        BulkItem: {
            error: unknown;
            /** @description The ticket key, when the reader may see the ticket now. */
            key: string | null;
            /** @enum {string} */
            outcome: "done" | "failed" | "skipped" | "pending";
            position: number;
            /** @description The ticket as it was given: an id or a key. */
            ref: string;
            /** @description For a clone, the copy the item made, while the reader may see it. */
            result: ({
                attachments: number;
                key: string;
                /** @description What the copy does not have: values left out, as the create body names them, and `attachments` or `links` when the caller may not add those. */
                left: string[];
                links: number;
                ticket: {
                    id: number;
                    key: string;
                } & {
                    [key: string]: unknown;
                };
                webLinks: number;
            } & {
                [key: string]: unknown;
            }) | null;
            statusCode: number | null;
        } & {
            [key: string]: unknown;
        };
        BulkOperation: {
            /** @enum {string} */
            action: "edit" | "move" | "transition" | "delete" | "clone";
            cancelRequested: boolean;
            /** Format: date-time */
            createdAt: string;
            failed: number;
            finishedAt: string | null;
            id: number;
            /** @description What the operation applies, as it was asked. */
            params: unknown;
            pending: number;
            skipped: number;
            startedAt: string | null;
            /** @description `queued`, `running`, `done` or `cancelled`. */
            status: string;
            succeeded: number;
            total: number;
            userId: number;
        } & {
            [key: string]: unknown;
        };
        Change: {
            actor: components["schemas"]["PersonRef"] | null;
            /** Format: date-time */
            at: string;
            changeSet: string;
            field: string;
            from: {
                display: string | null;
                value: string | null;
            } & {
                [key: string]: unknown;
            };
            id: string;
            to: {
                display: string | null;
                value: string | null;
            } & {
                [key: string]: unknown;
            };
            transitionId: number | null;
        } & {
            [key: string]: unknown;
        };
        Comment: {
            author: components["schemas"]["PersonRef"] | null;
            /** @description Rich text, in the format the request asked for. */
            body: unknown;
            /** Format: date-time */
            createdAt: string;
            id: number;
            /** Format: date-time */
            updatedAt: string;
            version: number;
            visibility: {
                [key: string]: unknown;
            } | null;
        } & {
            [key: string]: unknown;
        };
        Error: {
            /** @description A short code, such as `not_found` or `invalid_fields`. */
            error: string;
            /** @description For `invalid_fields`: what is wrong with each field, by name. */
            fields?: {
                [key: string]: string;
            };
        } & {
            [key: string]: unknown;
        };
        Field: {
            id: number;
            name: string;
            type: string;
        } & {
            [key: string]: unknown;
        };
        Link: {
            /** Format: date-time */
            createdAt: string;
            /** @enum {string} */
            direction: "outward" | "inward";
            id: number;
            phrase: string;
            ticket: {
                closed: boolean;
                id: number;
                key: string;
                summary: string;
            } & {
                [key: string]: unknown;
            };
            type: {
                id: number;
                name: string;
            } & {
                [key: string]: unknown;
            };
        } & {
            [key: string]: unknown;
        };
        LinkType: {
            id: number;
            inward: string;
            isCopy: boolean;
            name: string;
            outward: string;
        } & {
            [key: string]: unknown;
        };
        Meta: {
            api: {
                /** @description Where the native API is, such as `/api/v1`. */
                base: string;
                /** @description The native API’s version. */
                version: string;
            };
            /** @description The oldest frontend this backend serves (older ones must update) and the one it was built with (older ones should). Null on a development build, which takes any frontend. */
            frontend: {
                minimum: string | null;
                recommended: string | null;
            };
            instance: {
                id: string;
                /** @constant */
                keyAlgorithm: "Ed25519";
                /** @description `SHA256:` and the key’s digest, base64url. */
                keyFingerprint: string;
                name: string;
                /** @description SPKI DER, base64url. */
                publicKey: string;
            };
            /** @constant */
            product: "taskmoor";
            signature?: {
                nonce: string;
                /** @description Ed25519 over `taskmoor-meta-v1`, the instance id and the nonce, one per line; base64url. */
                value: string;
            };
            signIn: {
                password: boolean;
                providers: components["schemas"]["MetaProvider"][];
            };
            /** @description The backend’s version. */
            version: string;
        };
        MetaProvider: {
            /** @description OpenID Connect only. */
            clientId: string | null;
            id: number;
            /** @description OpenID Connect: the issuer URL. SAML: the identity provider’s entity ID. */
            issuer: string;
            name: string;
            /** @enum {string} */
            protocol: "oidc" | "saml";
            /** @description SAML only: where sign-in requests go. */
            ssoUrl: string | null;
            /** @description Opens sign-in with this provider. */
            startUrl: string;
        };
        /** @description A person, by id and display name. */
        PersonRef: {
            id: number;
            name: string;
        } & {
            [key: string]: unknown;
        };
        Priority: {
            description: string;
            id: number;
            name: string;
            order: number;
        } & {
            [key: string]: unknown;
        };
        /** @description A JSON document an integration keeps under a key. */
        Property: {
            /** Format: date-time */
            createdAt: string;
            key: string;
            /** Format: date-time */
            updatedAt: string;
            /** @description Any JSON value, as it was set. */
            value: unknown;
        } & {
            [key: string]: unknown;
        };
        PropertyIndex: {
            alias: string | null;
            id: number;
            key: string;
            /** @description Dot-separated names inside the value; empty for all of it. */
            path: string;
            /** @enum {string} */
            type: "number" | "string" | "text" | "date" | "user";
        } & {
            [key: string]: unknown;
        };
        PropertyKey: {
            key: string;
            /** Format: date-time */
            updatedAt: string;
        } & {
            [key: string]: unknown;
        };
        QueryCheck: ({
            fields: ({
                name: string;
            } & {
                [key: string]: unknown;
            })[];
            /** @constant */
            ok: true;
            orderBy: ({
                direction: string;
                field: string;
            } & {
                [key: string]: unknown;
            })[];
        } & {
            [key: string]: unknown;
        }) | ({
            error: {
                length: number;
                message: string;
                position: number;
            } & {
                [key: string]: unknown;
            };
            /** @constant */
            ok: false;
        } & {
            [key: string]: unknown;
        });
        Release: {
            archived: boolean;
            description: string;
            id: number;
            name: string;
            overdue: boolean;
            progress: {
                closed: number;
                open: number;
                tickets: number;
            } & {
                [key: string]: unknown;
            };
            releaseDate: string | null;
            shipped: boolean;
            startDate: string | null;
            trackId: number;
        } & {
            [key: string]: unknown;
        };
        SavedSearch: {
            /** Format: date-time */
            createdAt: string;
            description: string;
            editable: boolean;
            id: number;
            importProblem: string | null;
            name: string;
            owner: components["schemas"]["PersonRef"];
            query: string;
            shares: unknown[];
            starred: boolean;
            /** Format: date-time */
            updatedAt: string;
            version: number;
        } & {
            [key: string]: unknown;
        };
        SearchTicket: {
            areas?: unknown[];
            assignee?: components["schemas"]["PersonRef"] | null;
            closedAt?: string | null;
            closeReason?: ({
                id: number;
                name: string;
            } & {
                [key: string]: unknown;
            }) | null;
            /** Format: date-time */
            createdAt?: string;
            creator?: components["schemas"]["PersonRef"] | null;
            /** @description Rich text, in the format the request asked for. */
            description?: unknown;
            dueDate?: string | null;
            environment?: unknown;
            /** @description Custom field values by field id. */
            fields?: {
                [key: string]: unknown;
            };
            followerCount?: number;
            foundInReleases?: unknown[];
            id: number;
            key: string;
            labels?: string[];
            number?: number;
            parent?: ({
                id: number;
                /** @description Null when the caller may not see it. */
                key: string | null;
                summary: string | null;
            } & {
                [key: string]: unknown;
            }) | null;
            priority?: ({
                color: string | null;
                icon: string | null;
                id: number;
                name: string;
            } & {
                [key: string]: unknown;
            }) | null;
            /** @description The global rank key: tickets sort by it. */
            rank?: string;
            requester?: components["schemas"]["PersonRef"] | null;
            startDate?: string | null;
            status?: {
                id: number;
                name: string;
                stage: components["schemas"]["Stage"];
            } & {
                [key: string]: unknown;
            };
            summary?: string;
            targetReleases?: unknown[];
            ticketType?: {
                color: string | null;
                icon: string | null;
                id: number;
                level: {
                    id: number;
                    name: string;
                    rank: number;
                } & {
                    [key: string]: unknown;
                };
                name: string;
            } & {
                [key: string]: unknown;
            };
            timeTracking?: {
                effortRatio: number | null;
                /** @description Seconds. */
                originalEstimate: number | null;
                /** @description Seconds. */
                remainingEstimate: number | null;
                /** @description Seconds. */
                timeSpent: number;
            } & {
                [key: string]: unknown;
            };
            track?: {
                id: number;
                key: string;
                name: string;
            } & {
                [key: string]: unknown;
            };
            /** @description Set while the ticket is in the trash. */
            trash?: {
                [key: string]: unknown;
            } | null;
            /** Format: date-time */
            updatedAt?: string;
            /** @description Send it back with a change to guard against a lost update. */
            version?: number;
            visibilityLevel?: ({
                id: number;
                name: string;
            } & {
                [key: string]: unknown;
            }) | null;
            voteCount?: number;
        } & {
            [key: string]: unknown;
        };
        /** @description Exact up to 10,000; beyond, an estimate from a sample, or "more than 10,000" when no sample is precise enough. */
        SearchTotal: {
            /** @description The count is an estimate, within 10% of the true count 99 times in 100. With neither flag, the count is a lower bound: there are more. */
            approximate?: boolean;
            count: number;
            /** @description The count is exact. */
            exact: boolean;
        } & {
            [key: string]: unknown;
        };
        SignedInUser: {
            email: string;
            id: number;
            isSiteAdmin: boolean;
            locale: string | null;
            name: string;
            timeZone: string | null;
        } & {
            [key: string]: unknown;
        };
        SimilarTickets: {
            /** @description What made the vectors, such as `local:all-MiniLM-L6-v2` (the bundled model); null when the server has embeddings off. */
            model: string | null;
            /** @description Present when `reasons` was asked for: true when an AI model re-ordered the first candidates in time, false for the embedding order alone. */
            reranked?: boolean;
            similar: ({
                /** @description The comment that matched, one the caller may read; never its text. */
                commentId?: number;
                /** @description With `reasons` and a re-ranking model: whether the model takes it for a duplicate. */
                likely?: boolean;
                /**
                 * @description Whether the ticket’s summary and description or one of its comments matched best.
                 * @enum {string}
                 */
                match: "ticket" | "comment";
                /** @description With `reasons` and a re-ranking model: why it may be a duplicate. */
                reason?: string;
                /** @description Cosine similarity, -1 to 1: higher is closer. */
                score: number;
                ticket: components["schemas"]["SearchTicket"];
            } & {
                [key: string]: unknown;
            })[];
        } & {
            [key: string]: unknown;
        };
        Sprint: {
            boardId: number;
            completedAt: string | null;
            endAt: string | null;
            goal: string;
            id: number;
            name: string;
            sequence: number;
            startAt: string | null;
            startedAt: string | null;
            /** @enum {string} */
            state: "future" | "active" | "closed";
            version: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * @description The stage of a status: to do, in progress or done.
         * @enum {string}
         */
        Stage: "new" | "active" | "closed";
        Status: {
            description: string;
            id: number;
            name: string;
            order: number;
            stage: components["schemas"]["Stage"];
        } & {
            [key: string]: unknown;
        };
        Ticket: {
            areas: unknown[];
            assignee: components["schemas"]["PersonRef"] | null;
            closedAt: string | null;
            closeReason: ({
                id: number;
                name: string;
            } & {
                [key: string]: unknown;
            }) | null;
            /** Format: date-time */
            createdAt: string;
            creator: components["schemas"]["PersonRef"] | null;
            /** @description Rich text, in the format the request asked for. */
            description: unknown;
            dueDate: string | null;
            environment: unknown;
            /** @description Custom field values by field id. */
            fields: {
                [key: string]: unknown;
            };
            followerCount: number;
            foundInReleases: unknown[];
            id: number;
            /** @description The track key and the number, such as `PAY-12`. */
            key: string;
            labels: string[];
            number: number;
            parent: ({
                id: number;
                /** @description Null when the caller may not see it. */
                key: string | null;
                summary: string | null;
            } & {
                [key: string]: unknown;
            }) | null;
            priority: ({
                color: string | null;
                icon: string | null;
                id: number;
                name: string;
            } & {
                [key: string]: unknown;
            }) | null;
            /** @description The global rank key: tickets sort by it. */
            rank: string;
            requester: components["schemas"]["PersonRef"] | null;
            startDate: string | null;
            status: {
                id: number;
                name: string;
                stage: components["schemas"]["Stage"];
            } & {
                [key: string]: unknown;
            };
            summary: string;
            targetReleases: unknown[];
            ticketType: {
                color: string | null;
                icon: string | null;
                id: number;
                level: {
                    id: number;
                    name: string;
                    rank: number;
                } & {
                    [key: string]: unknown;
                };
                name: string;
            } & {
                [key: string]: unknown;
            };
            timeTracking: {
                effortRatio: number | null;
                /** @description Seconds. */
                originalEstimate: number | null;
                /** @description Seconds. */
                remainingEstimate: number | null;
                /** @description Seconds. */
                timeSpent: number;
            } & {
                [key: string]: unknown;
            };
            track: {
                id: number;
                key: string;
                name: string;
            } & {
                [key: string]: unknown;
            };
            /** @description Set while the ticket is in the trash. */
            trash: {
                [key: string]: unknown;
            } | null;
            /** Format: date-time */
            updatedAt: string;
            /** @description Send it back with a change to guard against a lost update. */
            version: number;
            visibilityLevel: ({
                id: number;
                name: string;
            } & {
                [key: string]: unknown;
            }) | null;
            voteCount: number;
        } & {
            [key: string]: unknown;
        };
        /** @description Read-only info fields, computed from comments and history. Only comments everyone who sees the ticket may read count. */
        TicketInfo: {
            daysSinceLastComment: number | null;
            /** @description When someone other than the requester first commented. */
            firstResponse: string | null;
            lastComment: string | null;
            /** @description The requester, the assignee and everyone who wrote a comment. */
            participants: components["schemas"]["PersonRef"][];
            timeInStatus: ({
                seconds: number;
                status: {
                    id: number;
                    name: string;
                } & {
                    [key: string]: unknown;
                };
                visits: number;
            } & {
                [key: string]: unknown;
            })[];
        } & {
            [key: string]: unknown;
        };
        TicketType: {
            color: string | null;
            description: string;
            icon: string | null;
            id: number;
            level: {
                id: number;
                name: string;
                rank: number;
            } & {
                [key: string]: unknown;
            };
            name: string;
            trackId: number | null;
        } & {
            [key: string]: unknown;
        };
        TimeEntry: {
            author: components["schemas"]["PersonRef"] | null;
            /** Format: date-time */
            createdAt: string;
            description: string;
            /** @description Seconds. */
            duration: number;
            id: number;
            /** Format: date-time */
            startedAt: string;
            /** Format: date-time */
            updatedAt: string;
        } & {
            [key: string]: unknown;
        };
        Track: {
            archived: boolean;
            /** Format: date-time */
            createdAt: string;
            description: string;
            features: {
                [key: string]: boolean;
            };
            id: number;
            key: string;
            /** @enum {string} */
            mode: "shared" | "local";
            name: string;
            owner: components["schemas"]["PersonRef"] | null;
            /** @enum {string} */
            type: "software" | "business" | "service" | "discovery";
            /** Format: date-time */
            updatedAt: string;
        } & {
            [key: string]: unknown;
        };
        Transition: {
            id: number;
            /** @description The fields its form asks for. */
            layout: string[];
            name: string;
            to: {
                id: number;
                name: string;
                stage: components["schemas"]["Stage"];
            } & {
                [key: string]: unknown;
            };
        } & {
            [key: string]: unknown;
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    getMeta: {
        parameters: {
            query?: {
                /** @description The calling frontend’s version (its `version.json`). A frontend on a registered origin is listed with the version it last reported. */
                frontend?: string;
                /** @description 16 to 128 base64url characters the instance signs, chosen afresh by the caller. */
                nonce?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The instance. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Meta"];
                };
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    listPropertyIndexes: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Every index, oldest first. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        propertyIndexes: components["schemas"]["PropertyIndex"][];
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    createPropertyIndex: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @default null */
                    alias?: string | null;
                    key: string;
                    /** @default  */
                    path?: string;
                    /** @enum {string} */
                    type: "number" | "string" | "text" | "date" | "user";
                };
            };
        };
        responses: {
            /** @description The new index. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        propertyIndex: components["schemas"]["PropertyIndex"];
                    };
                };
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The resource changed or is in a state that refuses this; read it again. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    deletePropertyIndex: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The index’s id. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Dropped. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The resource changed or is in a state that refuses this; read it again. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    listBoards: {
        parameters: {
            query?: {
                teamId?: number;
                trackId?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The boards, by name. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        boards: components["schemas"]["BoardSummary"][];
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    createBoard: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    adminIds?: number[];
                    /** @enum {string} */
                    boardFilterDisplay?: "buttons" | "dropdown";
                    boardFilters?: {
                        /** @default  */
                        description?: string;
                        id?: string;
                        name: string;
                        query: string;
                    }[];
                    cardRules?: {
                        /** @enum {string} */
                        colourBy: "none" | "type" | "priority" | "assignee" | "queries";
                        /** @default [] */
                        colours?: {
                            colour: string;
                            id?: string;
                            query: string;
                        }[];
                        /** @default true */
                        daysInColumn?: boolean;
                        /** @default [] */
                        fields?: (("assignee" | "priority" | "points" | "dueDate" | "startDate" | "labels" | "targetReleases" | "areas" | "requester" | "parent" | "track" | "voteCount" | "followerCount" | "timeTracking" | "createdAt" | "updatedAt") | string)[];
                    };
                    columns?: {
                        id?: string;
                        /** @default null */
                        max?: number | null;
                        /** @default null */
                        min?: number | null;
                        name: string;
                        /** @default [] */
                        statusIds?: number[];
                    }[];
                    description?: string;
                    /** @enum {string} */
                    kind: "scrum" | "kanban";
                    name: string;
                    source?: {
                        query: string;
                    } | {
                        savedSearchId: number;
                    };
                    sprintSettings?: {
                        cycle?: {
                            lengthDays: number;
                            /** @default UTC */
                            timeZone?: string;
                        } | null;
                        estimation: {
                            fieldId?: number;
                            /** @enum {string} */
                            statistic: "ticketCount" | "originalEstimate" | "field";
                        };
                        parallelSprints: boolean;
                        /** @enum {string} */
                        timeTracking: "none" | "remainingEstimate";
                    };
                    subFilter?: {
                        query: string;
                    } | null;
                    swimlanes?: {
                        /** @default [] */
                        lanes?: {
                            id?: string;
                            name: string;
                            query: string;
                        }[];
                        /** @enum {string} */
                        mode: "none" | "queries" | "assignees" | "parents";
                        /** @default Everything else */
                        otherName?: string;
                        /**
                         * @default last
                         * @enum {string}
                         */
                        unassigned?: "first" | "last";
                    };
                    teamId?: number | null;
                    trackId?: number | null;
                };
            };
        };
        responses: {
            /** @description The new board. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        board: components["schemas"]["Board"];
                    };
                };
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The resource changed or is in a state that refuses this; read it again. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getBoard: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The board’s id. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The board and the statuses its columns may take. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        board: components["schemas"]["Board"];
                        statuses: {
                            [key: string]: unknown;
                        }[];
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getBacklog: {
        parameters: {
            query?: {
                limit?: number;
            };
            header?: never;
            path: {
                /** @description The board’s id. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Sprint sections, then the backlog, in rank order with totals. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Backlog"];
                };
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getBoardCards: {
        parameters: {
            query?: {
                filters?: string;
                limit?: number;
                people?: string;
                sprints?: string;
            };
            header?: never;
            path: {
                /** @description The board’s id. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The cards the caller may see, in rank order. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BoardData"];
                };
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    listBoardProperties: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The board’s id. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Its keys, in order, with when each was last set. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        properties: components["schemas"]["PropertyKey"][];
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getBoardProperty: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The board’s id. */
                id: string;
                /** @description The property key: 1 to 255 characters, percent-encoded. */
                key: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The property. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        property: components["schemas"]["Property"];
                    };
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    setBoardProperty: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The board’s id. */
                id: string;
                /** @description The property key: 1 to 255 characters, percent-encoded. */
                key: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    value: unknown;
                };
            };
        };
        responses: {
            /** @description Replaced. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        property: components["schemas"]["Property"];
                    };
                };
            };
            /** @description Set for the first time. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        property: components["schemas"]["Property"];
                    };
                };
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The resource changed or is in a state that refuses this; read it again. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    deleteBoardProperty: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The board’s id. */
                id: string;
                /** @description The property key: 1 to 255 characters, percent-encoded. */
                key: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Deleted. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The resource changed or is in a state that refuses this; read it again. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    listSprints: {
        parameters: {
            query?: {
                state?: "future" | "active" | "closed";
            };
            header?: never;
            path: {
                /** @description The board’s id. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Its sprints in order. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        sprints: components["schemas"]["Sprint"][];
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    createSprint: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The board’s id. */
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    endAt?: string | null;
                    goal?: string;
                    name?: string;
                    startAt?: string | null;
                };
            };
        };
        responses: {
            /** @description The new future sprint. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        sprint: components["schemas"]["Sprint"];
                    };
                };
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The resource changed or is in a state that refuses this; read it again. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    listBulkOperations: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The 50 most recent, newest first. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        bulkOperations: components["schemas"]["BulkOperation"][];
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    createBulkOperation: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @constant */
                    action: "edit";
                    edit: {
                        areaIds?: number[];
                        assigneeId?: number | null;
                        closeReasonId?: number | null;
                        description?: unknown;
                        dueDate?: string | null;
                        environment?: unknown;
                        fields?: {
                            [key: string]: unknown;
                        };
                        foundInReleaseIds?: number[];
                        labels?: string[];
                        originalEstimate?: (string | number) | null;
                        parent?: (number | string) | null;
                        priorityId?: number | null;
                        remainingEstimate?: (string | number) | null;
                        requesterId?: number;
                        startDate?: string | null;
                        statusId?: number;
                        summary?: string;
                        targetReleaseIds?: number[];
                        ticketTypeId?: number;
                        visibilityLevelId?: number | null;
                    };
                    query?: string;
                    tickets?: (number | string)[];
                } | {
                    /** @constant */
                    action: "move";
                    move: {
                        parent?: (number | string) | null;
                        statusId?: number;
                        subticketTypeId?: number;
                        ticketTypeId?: number;
                        track: number | string;
                        visibilityLevelId?: number | null;
                    };
                    query?: string;
                    tickets?: (number | string)[];
                } | {
                    /** @constant */
                    action: "transition";
                    query?: string;
                    tickets?: (number | string)[];
                    transition: {
                        fields?: {
                            [key: string]: unknown;
                        };
                        statusId?: number;
                        transitionId?: number;
                    };
                } | {
                    /** @constant */
                    action: "delete";
                    query?: string;
                    tickets?: (number | string)[];
                };
            };
        };
        responses: {
            /** @description Started; poll the operation for its progress. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        bulkOperation: components["schemas"]["BulkOperation"];
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The resource changed or is in a state that refuses this; read it again. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getBulkOperation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The bulk operation. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The operation. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        bulkOperation: components["schemas"]["BulkOperation"];
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    cancelBulkOperation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The bulk operation. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Cancelling. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        bulkOperation: components["schemas"]["BulkOperation"];
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The resource changed or is in a state that refuses this; read it again. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    listBulkItems: {
        parameters: {
            query?: {
                after?: number;
                limit?: number;
                outcome?: "done" | "failed" | "skipped" | "pending";
            };
            header?: never;
            path: {
                /** @description The bulk operation. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of results. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: components["schemas"]["BulkItem"][];
                        /** @description The cursor of the next page (an id); null on the last one. */
                        next: number | null;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    listFields: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The fields. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        fields: components["schemas"]["Field"][];
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    listLinkTypes: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The link types, and whether linking is on. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        enabled: boolean;
                        linkTypes: components["schemas"]["LinkType"][];
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    listPriorities: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The priorities. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        priorities: components["schemas"]["Priority"][];
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getRelease: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The release’s id. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The release with its approvers. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        release: components["schemas"]["Release"];
                    };
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    listSavedSearches: {
        parameters: {
            query?: {
                filter?: "visible" | "mine" | "starred";
                q?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The saved searches. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        savedSearches: components["schemas"]["SavedSearch"][];
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    createSavedSearch: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    columns?: string[] | null;
                    description?: string;
                    name: string;
                    query: string;
                    shares?: ({
                        /** @constant */
                        scope: "user";
                        userId: number;
                    } | {
                        groupId: number;
                        /** @constant */
                        scope: "group";
                    } | {
                        roleId?: number | null;
                        /** @constant */
                        scope: "track";
                        trackId: number;
                    } | {
                        /** @constant */
                        scope: "any_user";
                    } | {
                        /** @constant */
                        scope: "public";
                    })[];
                };
            };
        };
        responses: {
            /** @description The saved search. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        savedSearch: components["schemas"]["SavedSearch"];
                    };
                };
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The resource changed or is in a state that refuses this; read it again. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getSavedSearch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The saved search’s id. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The saved search. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        savedSearch: components["schemas"]["SavedSearch"];
                    };
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    search: {
        parameters: {
            query?: {
                archived?: boolean | ("true" | "false");
                count?: boolean | ("true" | "false");
                cursor?: string;
                fields?: string | string[];
                limit?: number;
                q?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of the tickets the query finds, as the caller may see them. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description The cursor of the next page; null on the last one. */
                        next: string | null;
                        tickets: components["schemas"]["SearchTicket"][];
                        total?: components["schemas"]["SearchTotal"];
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    searchLong: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    archived?: boolean | ("true" | "false");
                    count?: boolean | ("true" | "false");
                    cursor?: string;
                    fields?: string | string[];
                    /** @default 50 */
                    limit?: number;
                    /** @default  */
                    q?: string;
                };
            };
        };
        responses: {
            /** @description A page of tickets. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description The cursor of the next page; null on the last one. */
                        next: string | null;
                        tickets: components["schemas"]["SearchTicket"][];
                        total?: components["schemas"]["SearchTotal"];
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The resource changed or is in a state that refuses this; read it again. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    checkQuery: {
        parameters: {
            query: {
                q: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Valid, with the fields it names; or where it goes wrong. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["QueryCheck"];
                };
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getSession: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The caller. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        user: components["schemas"]["SignedInUser"];
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    signIn: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    email: string;
                    password: string;
                };
            };
        };
        responses: {
            /** @description Signed in, or a second factor is needed. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        status: string;
                        user?: components["schemas"]["SignedInUser"];
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The resource changed or is in a state that refuses this; read it again. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    signOut: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The session is over. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The resource changed or is in a state that refuses this; read it again. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    completeSprint: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The sprint’s id. */
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    moveTo: {
                        /** @constant */
                        type: "backlog";
                    } | {
                        sprintId: number;
                        /** @constant */
                        type: "sprint";
                    } | {
                        name?: string;
                        /** @constant */
                        type: "new";
                    };
                };
            };
        };
        responses: {
            /** @description The closed sprint and where its tickets went. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        carriedOver: number;
                        completed: number;
                        sprint: components["schemas"]["Sprint"];
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The resource changed or is in a state that refuses this; read it again. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    listSprintProperties: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The sprint’s id. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Its keys, in order, with when each was last set. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        properties: components["schemas"]["PropertyKey"][];
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getSprintProperty: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The sprint’s id. */
                id: string;
                /** @description The property key: 1 to 255 characters, percent-encoded. */
                key: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The property. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        property: components["schemas"]["Property"];
                    };
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    setSprintProperty: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The sprint’s id. */
                id: string;
                /** @description The property key: 1 to 255 characters, percent-encoded. */
                key: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    value: unknown;
                };
            };
        };
        responses: {
            /** @description Replaced. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        property: components["schemas"]["Property"];
                    };
                };
            };
            /** @description Set for the first time. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        property: components["schemas"]["Property"];
                    };
                };
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The resource changed or is in a state that refuses this; read it again. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    deleteSprintProperty: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The sprint’s id. */
                id: string;
                /** @description The property key: 1 to 255 characters, percent-encoded. */
                key: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Deleted. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The resource changed or is in a state that refuses this; read it again. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    startSprint: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The sprint’s id. */
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: date-time */
                    endAt?: string;
                    goal?: string;
                    name?: string;
                    /** Format: date-time */
                    startAt?: string;
                };
            };
        };
        responses: {
            /** @description The active sprint. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        sprint: components["schemas"]["Sprint"];
                    };
                };
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The resource changed or is in a state that refuses this; read it again. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    addSprintTickets: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The sprint’s id. */
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    tickets: (number | string)[];
                };
            };
        };
        responses: {
            /** @description How many were added, and whether after its start. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        added: number;
                        afterStart: boolean;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The resource changed or is in a state that refuses this; read it again. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    listStatuses: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The statuses with their stages. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        statuses: components["schemas"]["Status"][];
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    listTickets: {
        parameters: {
            query?: {
                after?: string;
                cursor?: string;
                format?: "doc" | "adf" | "markdown" | "wiki" | "text";
                limit?: number;
                parent?: string;
                track?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of tickets. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description The cursor of the next page; null on the last one. */
                        next: string | null;
                        tickets: components["schemas"]["Ticket"][];
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    createTicket: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    areaIds?: number[];
                    assigneeId?: number | null;
                    closeReasonId?: number | null;
                    description?: unknown;
                    dueDate?: string | null;
                    environment?: unknown;
                    fields?: {
                        [key: string]: unknown;
                    };
                    foundInReleaseIds?: number[];
                    labels?: string[];
                    originalEstimate?: (string | number) | null;
                    parent?: (number | string) | null;
                    priorityId?: number | null;
                    remainingEstimate?: (string | number) | null;
                    requesterId?: number;
                    startDate?: string | null;
                    summary?: string;
                    targetReleaseIds?: number[];
                    ticketTypeId?: number;
                    track: number | string;
                    visibilityLevelId?: number | null;
                };
            };
        };
        responses: {
            /** @description The new ticket. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        ticket: components["schemas"]["Ticket"];
                    };
                };
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The resource changed or is in a state that refuses this; read it again. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getTicket: {
        parameters: {
            query?: {
                /** @description The rich-text format of bodies, in and out; the stored document by default. `text` (plain text) is for answers only. */
                format?: "doc" | "adf" | "markdown" | "wiki" | "text";
            };
            header?: never;
            path: {
                /** @description The ticket: its id or its key, such as `PAY-12`. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The ticket. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        ticket: components["schemas"]["Ticket"];
                    };
                };
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    deleteTicket: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The ticket: its id or its key, such as `PAY-12`. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description In the trash; it can be restored until it is purged. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The resource changed or is in a state that refuses this; read it again. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    updateTicket: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The ticket: its id or its key, such as `PAY-12`. */
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    areaIds?: number[];
                    assigneeId?: number | null;
                    closeReasonId?: number | null;
                    description?: unknown;
                    dueDate?: string | null;
                    environment?: unknown;
                    fields?: {
                        [key: string]: unknown;
                    };
                    foundInReleaseIds?: number[];
                    labels?: string[];
                    originalEstimate?: (string | number) | null;
                    parent?: (number | string) | null;
                    priorityId?: number | null;
                    remainingEstimate?: (string | number) | null;
                    requesterId?: number;
                    startDate?: string | null;
                    statusId?: number;
                    summary?: string;
                    targetReleaseIds?: number[];
                    ticketTypeId?: number;
                    version?: number;
                    visibilityLevelId?: number | null;
                };
            };
        };
        responses: {
            /** @description The ticket as it is now. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        ticket: components["schemas"]["Ticket"];
                    };
                };
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The resource changed or is in a state that refuses this; read it again. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    cloneTicket: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The ticket: its id or its key, such as `PAY-12`. */
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @default true */
                    attachments?: boolean;
                    /** @default false */
                    descendants?: boolean;
                    /** @default true */
                    links?: boolean;
                    /** @default true */
                    subtickets?: boolean;
                    summary?: string;
                    track?: number | string;
                };
            };
        };
        responses: {
            /** @description Started; poll the operation for its progress and the copies. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        bulkOperation: components["schemas"]["BulkOperation"];
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The resource changed or is in a state that refuses this; read it again. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    listComments: {
        parameters: {
            query?: {
                cursor?: number;
                format?: string;
                limit?: number;
                order?: "asc" | "desc";
            };
            header?: never;
            path: {
                /** @description The ticket: its id or its key, such as `PAY-12`. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of the comments the caller may see. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        comments: components["schemas"]["Comment"][];
                        /** @description The cursor of the next page (an id); null on the last one. */
                        next: number | null;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    addComment: {
        parameters: {
            query?: {
                /** @description The rich-text format of bodies, in and out; the stored document by default. `text` (plain text) is for answers only. */
                format?: "doc" | "adf" | "markdown" | "wiki" | "text";
            };
            header?: never;
            path: {
                /** @description The ticket: its id or its key, such as `PAY-12`. */
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    body: unknown;
                    visibility?: ({
                        roleId: number;
                    } | {
                        groupId: number;
                    }) | null;
                };
            };
        };
        responses: {
            /** @description The new comment. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        comment: components["schemas"]["Comment"];
                    };
                };
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The resource changed or is in a state that refuses this; read it again. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    deleteComment: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The comment’s id. */
                commentId: string;
                /** @description The ticket: its id or its key, such as `PAY-12`. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Deleted. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The resource changed or is in a state that refuses this; read it again. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    updateComment: {
        parameters: {
            query?: {
                /** @description The rich-text format of bodies, in and out; the stored document by default. `text` (plain text) is for answers only. */
                format?: "doc" | "adf" | "markdown" | "wiki" | "text";
            };
            header?: never;
            path: {
                /** @description The comment’s id. */
                commentId: string;
                /** @description The ticket: its id or its key, such as `PAY-12`. */
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    body?: unknown;
                    visibility?: ({
                        roleId: number;
                    } | {
                        groupId: number;
                    }) | null;
                };
            };
        };
        responses: {
            /** @description The comment as it is now. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        comment: components["schemas"]["Comment"];
                    };
                };
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The resource changed or is in a state that refuses this; read it again. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getTicketHistory: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
                order?: "desc" | "asc";
            };
            header?: never;
            path: {
                /** @description The ticket: its id or its key, such as `PAY-12`. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of changes. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        changes: components["schemas"]["Change"][];
                        /** @description The cursor of the next page; null on the last one. */
                        next: string | null;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getTicketInfo: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The ticket: its id or its key, such as `PAY-12`. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The info fields. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        info: components["schemas"]["TicketInfo"];
                    };
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    listLinks: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The ticket: its id or its key, such as `PAY-12`. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Its links to the tickets the caller may see. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        links: components["schemas"]["Link"][];
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    addLink: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The ticket: its id or its key, such as `PAY-12`. */
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /**
                     * @default outward
                     * @enum {string}
                     */
                    direction?: "outward" | "inward";
                    linkTypeId: number;
                    ticket: number | string;
                };
            };
        };
        responses: {
            /** @description The new link. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        link: components["schemas"]["Link"];
                    };
                };
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The resource changed or is in a state that refuses this; read it again. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    removeLink: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The ticket: its id or its key, such as `PAY-12`. */
                id: string;
                /** @description The link’s id. */
                linkId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Removed. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The resource changed or is in a state that refuses this; read it again. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    listTicketProperties: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The ticket: its id or its key, such as `PAY-12`. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Its keys, in order, with when each was last set. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        properties: components["schemas"]["PropertyKey"][];
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getTicketProperty: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The ticket: its id or its key, such as `PAY-12`. */
                id: string;
                /** @description The property key: 1 to 255 characters, percent-encoded. */
                key: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The property. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        property: components["schemas"]["Property"];
                    };
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    setTicketProperty: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The ticket: its id or its key, such as `PAY-12`. */
                id: string;
                /** @description The property key: 1 to 255 characters, percent-encoded. */
                key: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    value: unknown;
                };
            };
        };
        responses: {
            /** @description Replaced. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        property: components["schemas"]["Property"];
                    };
                };
            };
            /** @description Set for the first time. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        property: components["schemas"]["Property"];
                    };
                };
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The resource changed or is in a state that refuses this; read it again. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    deleteTicketProperty: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The ticket: its id or its key, such as `PAY-12`. */
                id: string;
                /** @description The property key: 1 to 255 characters, percent-encoded. */
                key: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Deleted. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The resource changed or is in a state that refuses this; read it again. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    rankTicket: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The ticket: its id or its key, such as `PAY-12`. */
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    after?: number | string;
                    before?: number | string;
                    /** @enum {string} */
                    position?: "top" | "bottom";
                };
            };
        };
        responses: {
            /** @description The ticket with its new rank. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        ticket: components["schemas"]["Ticket"];
                    };
                };
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The resource changed or is in a state that refuses this; read it again. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    similarTickets: {
        parameters: {
            query?: {
                /** @description How many tickets, at most 50. */
                limit?: number;
                /** @description Leave out tickets less similar than this (cosine similarity, -1 to 1). */
                minScore?: number;
            };
            header?: never;
            path: {
                /** @description The ticket: its id or its key, such as `PAY-12`. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The similar tickets, best first. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SimilarTickets"];
                };
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    listTimeEntries: {
        parameters: {
            query?: {
                cursor?: number;
                limit?: number;
            };
            header?: never;
            path: {
                /** @description The ticket: its id or its key, such as `PAY-12`. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of time entries. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description The cursor of the next page (an id); null on the last one. */
                        next: number | null;
                        timeEntries: components["schemas"]["TimeEntry"][];
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    logTime: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The ticket: its id or its key, such as `PAY-12`. */
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    description?: string;
                    duration: string | number;
                    remainingEstimate?: {
                        /** @constant */
                        mode: "auto";
                    } | {
                        /** @constant */
                        mode: "leave";
                    } | {
                        /** @constant */
                        mode: "set";
                        value: string | number;
                    } | {
                        /** @constant */
                        mode: "reduce";
                        value: string | number;
                    };
                    startedAt?: string;
                    visibility?: ({
                        roleId: number;
                    } | {
                        groupId: number;
                    }) | null;
                };
            };
        };
        responses: {
            /** @description The new time entry. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        timeEntry: components["schemas"]["TimeEntry"];
                    };
                };
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The resource changed or is in a state that refuses this; read it again. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    listTransitions: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The ticket: its id or its key, such as `PAY-12`. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Its transitions. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        transitions: components["schemas"]["Transition"][];
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    transitionTicket: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The ticket: its id or its key, such as `PAY-12`. */
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    comment?: unknown;
                    commentVisibility?: ({
                        roleId: number;
                    } | {
                        groupId: number;
                    }) | null;
                    fields?: {
                        [key: string]: unknown;
                    };
                    transitionId: number;
                    version?: number;
                };
            };
        };
        responses: {
            /** @description The ticket in its new status. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        ticket: components["schemas"]["Ticket"];
                    };
                };
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The resource changed or is in a state that refuses this; read it again. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    similarToText: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @description A ticket to leave out (its key or id), such as the one being edited. */
                    excludeTicket?: number | string;
                    /** @default 10 */
                    limit?: number;
                    minScore?: number;
                    /**
                     * @description Have the configured AI model re-rank the first candidates and give a reason for each, within 2 seconds of the request; without a model, or past the time, the embedding order is answered with `reranked: false`.
                     * @default false
                     */
                    reasons?: boolean;
                    /** @description What is being written: a summary, with the description after it if any. */
                    text: string;
                    /** @description Only tickets of this track (its key or id), such as the one being created in. */
                    track?: number | string;
                };
            };
        };
        responses: {
            /** @description The similar tickets, best first. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SimilarTickets"];
                };
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The resource changed or is in a state that refuses this; read it again. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    listTracks: {
        parameters: {
            query?: {
                after?: string;
                archived?: "exclude" | "include" | "only";
                categoryId?: number;
                limit?: number;
                mode?: "shared" | "local";
                q?: string;
                type?: "software" | "business" | "service" | "discovery";
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The tracks, by key. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description The cursor of the next page; null on the last one. */
                        next?: string | null;
                        tracks: components["schemas"]["Track"][];
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    createTrack: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    accessPolicyId?: number;
                    categoryId?: number | null;
                    color?: string | null;
                    copyFrom?: number;
                    description?: string;
                    features?: {
                        approvals?: boolean;
                        backlog?: boolean;
                        board?: boolean;
                        calendar?: boolean;
                        development?: boolean;
                        forms?: boolean;
                        releases?: boolean;
                        sprints?: boolean;
                        timeline?: boolean;
                    };
                    icon?: string | null;
                    key: string;
                    /** @enum {string} */
                    mode: "shared" | "local";
                    name: string;
                    ownerId?: number;
                    /** @enum {string} */
                    template?: "scrum" | "kanban" | "bug-tracking" | "business" | "blank";
                    /**
                     * @default software
                     * @enum {string}
                     */
                    type?: "software" | "business" | "service" | "discovery";
                    typeSetId?: number;
                };
            };
        };
        responses: {
            /** @description The new track, and the board a template made. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        board?: components["schemas"]["BoardSummary"];
                        track: components["schemas"]["Track"];
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The resource changed or is in a state that refuses this; read it again. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getTrack: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The track: its id or its key. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The track. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        track: components["schemas"]["Track"];
                    };
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    listTrackProperties: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The track: its id or its key. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Its keys, in order, with when each was last set. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        properties: components["schemas"]["PropertyKey"][];
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getTrackProperty: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The track: its id or its key. */
                id: string;
                /** @description The property key: 1 to 255 characters, percent-encoded. */
                key: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The property. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        property: components["schemas"]["Property"];
                    };
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    setTrackProperty: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The track: its id or its key. */
                id: string;
                /** @description The property key: 1 to 255 characters, percent-encoded. */
                key: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    value: unknown;
                };
            };
        };
        responses: {
            /** @description Replaced. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        property: components["schemas"]["Property"];
                    };
                };
            };
            /** @description Set for the first time. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        property: components["schemas"]["Property"];
                    };
                };
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The resource changed or is in a state that refuses this; read it again. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    deleteTrackProperty: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The track: its id or its key. */
                id: string;
                /** @description The property key: 1 to 255 characters, percent-encoded. */
                key: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Deleted. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The resource changed or is in a state that refuses this; read it again. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    listReleases: {
        parameters: {
            query?: {
                archived?: "exclude" | "include" | "only";
            };
            header?: never;
            path: {
                /** @description The track’s id. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Its releases with their progress. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        mayManage: boolean;
                        releases: components["schemas"]["Release"][];
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    createRelease: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The track’s id. */
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    description?: string;
                    name: string;
                    releaseDate?: string | null;
                    requireApprovals?: boolean;
                    startDate?: string | null;
                };
            };
        };
        responses: {
            /** @description The new release. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        release: components["schemas"]["Release"];
                    };
                };
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The resource changed or is in a state that refuses this; read it again. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    listTrackTicketTypes: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The track: its id or its key. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Its types in set order, and the one new tickets take by default. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        defaultTypeId: number | null;
                        ticketTypes: components["schemas"]["TicketType"][];
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    listUserProperties: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The person: their id, or `me`. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Its keys, in order, with when each was last set. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        properties: components["schemas"]["PropertyKey"][];
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getUserProperty: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The person: their id, or `me`. */
                id: string;
                /** @description The property key: 1 to 255 characters, percent-encoded. */
                key: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The property. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        property: components["schemas"]["Property"];
                    };
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    setUserProperty: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The person: their id, or `me`. */
                id: string;
                /** @description The property key: 1 to 255 characters, percent-encoded. */
                key: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    value: unknown;
                };
            };
        };
        responses: {
            /** @description Replaced. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        property: components["schemas"]["Property"];
                    };
                };
            };
            /** @description Set for the first time. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        property: components["schemas"]["Property"];
                    };
                };
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The resource changed or is in a state that refuses this; read it again. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    deleteUserProperty: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The person: their id, or `me`. */
                id: string;
                /** @description The property key: 1 to 255 characters, percent-encoded. */
                key: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Deleted. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The request is not valid: see `error` and, for fields, `fields`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description No session or token, or an expired one. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The session or token may not do this (its scope, or the person’s permissions). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description There is no such resource, or the caller may not see it. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description The resource changed or is in a state that refuses this; read it again. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
}
