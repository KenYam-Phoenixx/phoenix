/*
 * GNU AGPL-3.0 License
 *
 * Copyright (c) 2021 - present core.ai . All rights reserved.
 * Original work Copyright (c) 2012 - 2021 Adobe Systems Incorporated. All rights reserved.
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License
 * for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see https://opensource.org/licenses/AGPL-3.0.
 *
 */

// @INCLUDE_IN_API_DOCS

/*unittests: QuickOpen*/

/*
 * Displays a search bar where the user can quickly navigate to a different file by searching file names in
 * the project, and/or jump to a line number. Providers can plug in to offer additional search modes.
 */


define(function (require, exports, module) {


    var DocumentManager = require("document/DocumentManager"),
        EditorManager = require("editor/EditorManager"),
        MainViewManager = require("view/MainViewManager"),
        MainViewFactory = require("view/MainViewFactory"),
        CommandManager = require("command/CommandManager"),
        Strings = require("strings"),
        StringUtils = require("utils/StringUtils"),
        Commands = require("command/Commands"),
        ProjectManager = require("project/ProjectManager"),
        LanguageManager = require("language/LanguageManager"),
        FileSystemError = require("filesystem/FileSystemError"),
        ModalBar = require("widgets/ModalBar").ModalBar,
        QuickSearchField = require("search/QuickSearchField").QuickSearchField,
        StringMatch = require("utils/StringMatch"),
        ProviderRegistrationHandler = require("features/PriorityBasedRegistration").RegistrationHandler;

    var _providerRegistrationHandler = new ProviderRegistrationHandler(),
        _registerQuickOpenProvider = _providerRegistrationHandler.registerProvider.bind(_providerRegistrationHandler);

    /**
     * Represents the symbol kind
     * @type {Object}
     */
    var SymbolKind = {
        "1": "File",
        "2": "Module",
        "3": "Namespace",
        "4": "Package",
        "5": "Class",
        "6": "Method",
        "7": "Property",
        "8": "Field",
        "9": "Constructor",
        "10": "Enum",
        "11": "Interface",
        "12": "Function",
        "13": "Variable",
        "14": "Constant",
        "15": "String",
        "16": "Number",
        "17": "Boolean",
        "18": "Array",
        "19": "Object",
        "20": "Key",
        "21": "Null",
        "22": "EnumMember",
        "23": "Struct",
        "24": "Event",
        "25": "Operator",
        "26": "TypeParameter"
    };

    /**
     * The regular expression to check the cursor position
     * @private
     * @const {RegExp}
     */
    var CURSOR_POS_EXP = new RegExp(":([^,:]+)?([,:](.+)?)?");

    /**
     * Current plugin
     * @private
     * @type {QuickOpenPlugin}
     */
    var currentPlugin = null;

    /**
     *  @type {Array.<File>}
     *  @private
     */
    var fileList;

    /**
     * @type {$.Promise}
     * @private
     */
    var fileListPromise;

    /**
     * The currently open (or last open) QuickNavigateDialog
     * @type {?QuickNavigateDialog}
     * @private
     */
    var _curDialog;

    /**
     * Helper function to get the plugins based on the type of the current document.
     * @private
     * @returns {Array} Returns the plugings based on the languageId of the current document.
     */
    function _getPluginsForCurrentContext() {
        var curDoc = DocumentManager.getCurrentDocument();

        if (curDoc) {
            var languageId = curDoc.getLanguage().getId();
            return _providerRegistrationHandler.getProvidersForLanguageId(languageId);
        }

        return _providerRegistrationHandler.getProvidersForLanguageId(); //plugins registered for all
    }

    /**
     * Defines API for new QuickOpen plug-ins
     */
    function QuickOpenPlugin(name, languageIds, done, search, match, itemFocus, itemSelect, resultsFormatter, matcherOptions, label) {
        this.name = name;
        this.languageIds = languageIds;
        this.done = done;
        this.search = search;
        this.match = match;
        this.itemFocus = itemFocus;
        this.itemSelect = itemSelect;
        this.resultsFormatter = resultsFormatter;
        this.matcherOptions = matcherOptions;
        this.label = label;
    }

    /**
     * Creates and registers a new QuickOpenPlugin
     *
     * @param {Object} pluginDef - Plugin definition object containing the following properties:
     *   \{string} name - Plug-in name, **must be unique**.
     *   \{Array(string)} languageIds - Language Ids array. Example: ["javascript", "css", "html"]. To allow any language, pass []. Required.
     *   \{function()} [done] - Called when quick open is complete. Plug-in should clear its internal state. Optional.
     *   \{function(string, StringMatch.StringMatcher): (Array(SearchResult|string)|$.Promise)} search - Takes a query string and a StringMatcher (the use of which is optional but can speed up your searches) and returns
     *      an array of strings or result objects that match the query; or a Promise that resolves to such an array. Required.
     *   \{function(string): boolean} match - Takes a query string and returns true if this plug-in wants to provide
     *      results for this query. Required.
     *   \{function(?SearchResult|string, string, boolean)} [itemFocus] - Performs an action when a result has been highlighted (via arrow keys, or by becoming top of the list).
     *      Passed the highlighted search result item (as returned by search()), the current query string, and a flag that is true
     *      if the item was highlighted explicitly (arrow keys), not implicitly (at top of list after last search()). Optional.
     *   \{function(?SearchResult|string, string)} itemSelect - Performs an action when a result is chosen.
     *      Passed the highlighted search result item (as returned by search()), and the current query string. Required.
     *   \{function(SearchResult|string, string): string} [resultsFormatter] - Takes a query string and an item string and returns
     *      a "LI" item to insert into the displayed search results. Optional.
     *   \{Object} [matcherOptions] - Options to pass along to the StringMatcher (see StringMatch.StringMatcher
     *          for available options). Optional.
     *   \{string} [label] - If provided, the label to show before the query field. Optional.
     *
     * If itemFocus() makes changes to the current document or cursor/scroll position and then the user
     * cancels Quick Open (via Esc), those changes are automatically reverted.
     */
    function addQuickOpenPlugin(pluginDef) {
        var quickOpenProvider = new QuickOpenPlugin(
            pluginDef.name,
            pluginDef.languageIds,
            pluginDef.done,
            pluginDef.search,
            pluginDef.match,
            pluginDef.itemFocus,
            pluginDef.itemSelect,
            pluginDef.resultsFormatter,
            pluginDef.matcherOptions,
            pluginDef.label
        ),
            providerLanguageIds = pluginDef.languageIds.length ? pluginDef.languageIds : ["all"],
            providerPriority = pluginDef.priority || 0;

        _registerQuickOpenProvider(quickOpenProvider, providerLanguageIds, providerPriority);
    }

    /**
     * QuickNavigateDialog class
     * @private
     * @constructor
     */
    function QuickNavigateDialog() {
        this.$searchField = undefined; // defined when showDialog() is called

        // ModalBar event handlers & callbacks
        this._handleCloseBar = this._handleCloseBar.bind(this);

        // QuickSearchField callbacks
        this._handleItemSelect = this._handleItemSelect.bind(this);
        this._handleItemHighlight = this._handleItemHighlight.bind(this);
        this._filterCallback = this._filterCallback.bind(this);
        this._resultsFormatterCallback = this._resultsFormatterCallback.bind(this);

        // StringMatchers that cache in-progress query data.
        this._filenameMatcher = new StringMatch.StringMatcher({
            segmentedSearch: true
        });
        this._matchers = {};
    }

    /**
     * True if the search bar is currently open. Note that this is set to false immediately
     * when the bar starts closing; it doesn't wait for the ModalBar animation to finish.
     * @type {boolean}
     * @private
     */
    QuickNavigateDialog.prototype.isOpen = false;

    /**
     * @private
     * Handles caching of filename search information for the lifetime of a
     * QuickNavigateDialog (a single search until the dialog is dismissed)
     *
     * @type {StringMatch.StringMatcher}
     */
    QuickNavigateDialog.prototype._filenameMatcher = null;

    /**
     * @private
     * StringMatcher caches for each QuickOpen plugin that keep track of search
     * information for the lifetime of a QuickNavigateDialog (a single search
     * until the dialog is dismissed)
     *
     * @type {{string, StringMatch.StringMatcher}}
     */
    QuickNavigateDialog.prototype._matchers = null;

    /**
     * @private
     * If the dialog is closing, this will contain a deferred that is resolved
     * when it's done closing.
     * @type {$.Deferred}
     */
    QuickNavigateDialog.prototype._closeDeferred = null;


    /**
     * @private
     * Remembers the current document that was displayed when showDialog() was called.
     * @type {?string} full path
     */
    QuickNavigateDialog.prototype._origDocPath = null;

    /**
     * @private
     * Remembers the selection state in origDocPath that was present when showDialog() was called. Focusing on an
     * item can change the selection; we restore this original selection if the user presses Escape. Null if
     * no document was open when Quick Open was invoked.
     * @type {?{{start:{line:number, ch:number}, end:{line:number, ch:number}, primary:boolean, reversed:boolean}}}
     */
    QuickNavigateDialog.prototype._origSelections = null;

    /**
     * @private
     * Remembers the scroll position in origDocPath when showDialog() was called (see origSelection above).
     * @type {?{x:number, y:number}}
     */
    QuickNavigateDialog.prototype._origScrollPos = null;

    function _filenameFromPath(path, includeExtension) {
        var end;
        if (includeExtension) {
            end = path.length;
        } else {
            end = path.lastIndexOf(".");
            if (end === -1) {
                end = path.length;
            }
        }
        return path.slice(path.lastIndexOf("/") + 1, end);
    }

    /**
     * Attempts to extract a line number from the query where the line number
     * is followed by a colon. Callers should explicitly test result with isNaN()
     * @private
     * @param {string} query string to extract line number from
     * @return {{query: string, local: boolean, line: number, ch: number}} An object with
     *      the extracted line and column numbers, and two additional fields: query with the original position
     *      string and local indicating if the cursor position should be applied to the current file.
     *      Or null if the query is invalid
     */
    function extractCursorPos(query) {
        var regInfo = query.match(CURSOR_POS_EXP);

        if (query.length <= 1 || !regInfo ||
            (regInfo[1] && isNaN(regInfo[1])) ||
            (regInfo[3] && isNaN(regInfo[3]))) {

            return null;
        }

        return {
            query: regInfo[0],
            local: query[0] === ":",
            line: regInfo[1] - 1 || 0,
            ch: regInfo[3] - 1 || 0
        };
    }

    /**
     * Navigates to the appropriate file and file location given the selected item
     * and closes the dialog.
     *
     * Note, if selectedItem is null quick search should inspect $searchField for text
     * that may have not matched anything in the list, but may have information
     * for carrying out an action (e.g. go to line).
     * @private
     */
    QuickNavigateDialog.prototype._handleItemSelect = function (selectedItem, query) {

        var doClose = true,
            self = this;

        // Delegate to current plugin
        if (currentPlugin) {
            currentPlugin.itemSelect(selectedItem, query);
        } else {
            // Extract line/col number, if any
            var cursorPos = extractCursorPos(query);

            // Navigate to file and line number
            var fullPath = selectedItem && selectedItem.fullPath;
            if (fullPath) {
                // We need to fix up the current editor's scroll pos before switching to the next one. But if
                // we run the full close() now, ModalBar's animate-out won't be smooth (gets starved of cycles
                // during creation of the new editor). So we call prepareClose() to do *only* the scroll pos
                // fixup, and let the full close() be triggered later when the new editor takes focus.
                doClose = false;
                this.modalBar.prepareClose();
                CommandManager.execute(Commands.CMD_ADD_TO_WORKINGSET_AND_OPEN, { fullPath: fullPath })
                    .done(function () {
                        if (cursorPos) {
                            var editor = EditorManager.getCurrentFullEditor();
                            editor.setCursorPos(cursorPos.line, cursorPos.ch, true);
                        }
                    })
                    .always(function () {
                        // Ensure we finish closing even if file failed to open, or file was already current (in
                        // either case, we may not get a blur to trigger ModalBar to auto-close)
                        self.close();
                    });
            } else if (cursorPos) {
                EditorManager.getCurrentFullEditor().setCursorPos(cursorPos.line, cursorPos.ch, true);
            }
        }

        if (doClose) {
            this.close();
            MainViewManager.focusActivePane();
        }
    };

    /**
     * Opens the file specified by selected item if there is no current plug-in, otherwise defers handling
     * to the currentPlugin
     * @private
     */
    QuickNavigateDialog.prototype._handleItemHighlight = function (selectedItem, query, explicit) {
        if (currentPlugin && currentPlugin.itemFocus) {
            currentPlugin.itemFocus(selectedItem, query, explicit);
        }
    };

    /**
     * Closes the search bar; if search bar is already closing, returns the Promise that is tracking the
     * existing close activity.
     * @return {$.Promise} Resolved when the search bar is entirely closed.
     * @private
     */
    QuickNavigateDialog.prototype.close = function () {
        if (!this.isOpen) {
            return this.closePromise;
        }

        this.modalBar.close();  // triggers _handleCloseBar(), setting closePromise

        return this.closePromise;
    };

    QuickNavigateDialog.prototype._handleCloseBar = function (event, reason, modalBarClosePromise) {
        console.assert(!this.closePromise);
        this.closePromise = modalBarClosePromise;
        this.isOpen = false;

        var i,
            plugins = _getPluginsForCurrentContext();
        for (i = 0; i < plugins.length; i++) {
            var plugin = plugins[i].provider;
            if (plugin.done) {
                plugin.done();
            }
        }

        // Close popup & ensure we ignore any still-pending result promises
        this.searchField.destroy();

        // Restore original selection / scroll pos if closed via Escape
        if (reason === ModalBar.CLOSE_ESCAPE) {
            // We can reset the scroll position synchronously on ModalBar's "close" event (before close animation
            // completes) since ModalBar has already resized the editor and done its own scroll adjustment before
            // this event fired - so anything we set here will override the pos that was (re)set by ModalBar.
            var editor = EditorManager.getCurrentFullEditor();
            if (editor && this._origSelections) {
                editor.setSelections(this._origSelections);
            }
            if (editor && this._origScrollPos) {
                editor.setScrollPos(this._origScrollPos.x, this._origScrollPos.y);
            }
        }
    };


    function _doSearchFileList(query, matcher) {
        // Strip off line/col number suffix so it doesn't interfere with filename search
        var cursorPos = extractCursorPos(query);
        if (cursorPos && !cursorPos.local && cursorPos.query !== "") {
            query = query.replace(cursorPos.query, "");
        }

        // First pass: filter based on search string; convert to SearchResults containing extra info
        // for sorting & display
        var filteredList = $.map(fileList, function (fileInfo) {
            // Is it a match at all?
            // match query against the full path (with gaps between query characters allowed)
            var searchResult;

            searchResult = matcher.match(ProjectManager.makeProjectRelativeIfPossible(fileInfo.fullPath), query);

            if (searchResult) {
                searchResult.label = fileInfo.name;
                searchResult.fullPath = fileInfo.fullPath;
                searchResult.filenameWithoutExtension = _filenameFromPath(fileInfo.name, false);
            }
            return searchResult;
        });

        // Sort by "match goodness" tier first, then within each tier sort alphabetically - first by filename
        // sans extension, (so that "abc.js" comes before "abc-d.js"), then by filename, and finally (for
        // identically-named files) by full path
        StringMatch.multiFieldSort(filteredList, { matchGoodness: 0, filenameWithoutExtension: 1, label: 2, fullPath: 3 });

        return filteredList;
    }

    function searchFileList(query, matcher) {
        // The file index may still be loading asynchronously - if so, can't return a result yet
        if (!fileList) {
            var asyncResult = new $.Deferred();
            fileListPromise.done(function () {
                // Synchronously re-run the search call and resolve with its results
                asyncResult.resolve(_doSearchFileList(query, matcher));
            });
            return asyncResult.promise();

        }
        return _doSearchFileList(query, matcher);

    }

    /**
     * Handles changes to the current query in the search field.
     * @param {string} query The new query.
     * @return {$.Promise|Array.<*>|{error:?string}} The filtered list of results, an error object, or a Promise that yields one of those
     * @private
     */
    QuickNavigateDialog.prototype._filterCallback = function (query) {
        // Re-evaluate which plugin is active each time query string changes
        currentPlugin = null;

        // "Go to line" mode is special-cased
        var cursorPos = extractCursorPos(query);
        if (cursorPos && cursorPos.local) {
            // Bare Go to Line (no filename search) - can validate & jump to it now, without waiting for Enter/commit
            var editor = EditorManager.getCurrentFullEditor();

            // Validate (could just use 0 and lineCount() here, but in future might want this to work for inline editors too)
            if (cursorPos && editor && cursorPos.line >= editor.getFirstVisibleLine() && cursorPos.line <= editor.getLastVisibleLine()) {
                var from = { line: cursorPos.line, ch: cursorPos.ch },
                    to = { line: cursorPos.line };
                EditorManager.getCurrentFullEditor().setSelection(from, to, true);

                return { error: null };  // no error even though no results listed
            }
            return [];  // red error highlight: line number out of range, or no editor open

        }
        if (query === ":") {  // treat blank ":" query as valid, but no-op
            return { error: null };
        }

        var i,
            plugins = _getPluginsForCurrentContext();
        for (i = 0; i < plugins.length; i++) {
            var plugin = plugins[i].provider;
            if (plugin.match(query)) {
                currentPlugin = plugin;

                // Look up the StringMatcher for this plugin.
                var matcher = this._matchers[currentPlugin.name];
                if (!matcher) {
                    matcher = new StringMatch.StringMatcher(plugin.matcherOptions);
                    this._matchers[currentPlugin.name] = matcher;
                }
                this._updateDialogLabel(plugin, query);
                return plugin.search(query, matcher);
            }
        }

        // Reflect current search mode in UI
        this._updateDialogLabel(null, query);

        // No matching plugin: use default file search mode
        return searchFileList(query, this._filenameMatcher);
    };

    /**
     * Formats item's label as properly escaped HTML text, highlighting sections that match 'query'.
     * If item is a SearchResult generated by stringMatch(), uses its metadata about which string ranges
     * matched; else formats the label with no highlighting.
     * @param {!string|SearchResult} item
     * @param {?string} matchClass CSS class for highlighting matched text
     * @param {?function(boolean, string):string} rangeFilter
     * @return {!string} bolded, HTML-escaped result
     */
    function highlightMatch(item, matchClass, rangeFilter) {
        var label = item.label || item;
        matchClass = matchClass || "quicksearch-namematch";

        var stringRanges = item.stringRanges;
        if (!stringRanges) {
            // If result didn't come from stringMatch(), highlight nothing
            stringRanges = [{
                text: label,
                matched: false,
                includesLastSegment: true
            }];
        }

        var displayName = "";
        if (item.scoreDebug) {
            var sd = item.scoreDebug;
            displayName += '<span title="sp:' + sd.special + ', m:' + sd.match +
                ', ls:' + sd.lastSegment + ', b:' + sd.beginning +
                ', ld:' + sd.lengthDeduction + ', c:' + sd.consecutive + ', nsos: ' +
                sd.notStartingOnSpecial + ', upper: ' + sd.upper + '">(' + item.matchGoodness + ') </span>';
        }

        // Put the path pieces together, highlighting the matched parts
        stringRanges.forEach(function (range) {
            if (range.matched) {
                displayName += "<span class='" + matchClass + "'>";
            }

            var rangeText = rangeFilter ? rangeFilter(range.includesLastSegment, range.text) : range.text;
            displayName += StringUtils.breakableUrl(rangeText);

            if (range.matched) {
                displayName += "</span>";
            }
        });
        return displayName;
    }

    function defaultResultsFormatter(item, query) {
        query = query.slice(query.indexOf("@") + 1, query.length);

        var displayName = highlightMatch(item);
        return "<li>" + displayName + "</li>";
    }

    function _filenameResultsFormatter(item, query) {
        // For main label, we just want filename: drop most of the string
        function fileNameFilter(includesLastSegment, rangeText) {
            if (includesLastSegment) {
                var rightmostSlash = rangeText.lastIndexOf('/');
                return rangeText.substring(rightmostSlash + 1);  // safe even if rightmostSlash is -1
            }
            return "";

        }
        var displayName = highlightMatch(item, null, fileNameFilter);
        var displayPath = highlightMatch(item, "quicksearch-pathmatch");

        return "<li>" + displayName + "<br /><span class='quick-open-path'>" + displayPath + "</span></li>";
    }

    /**
     * Formats the entry for the given item to be displayed in the dropdown.
     * @private
     * @param {Object} item The item to be displayed.
     * @return {string} The HTML to be displayed.
     */
    QuickNavigateDialog.prototype._resultsFormatterCallback = function (item, query) {
        var formatter;

        if (currentPlugin) {
            // Plugins use their own formatter or the default formatter
            formatter = currentPlugin.resultsFormatter || defaultResultsFormatter;
        } else {
            // No plugin: default file search mode uses a special formatter
            formatter = _filenameResultsFormatter;
        }
        return formatter(item, query);
    };

    /**
     * Sets the value in the search field, updating the current mode and label based on the
     * given prefix.
     * @private
     * @param {string} prefix The prefix that determines which mode we're in: must be empty (for file search),
     *      "@" for go to definition, or ":" for go to line.
     * @param {string} initialString The query string to search for (without the prefix).
     */
    QuickNavigateDialog.prototype.setSearchFieldValue = function (prefix, initialString) {
        prefix = prefix || "";
        initialString = initialString || "";
        initialString = prefix + initialString;

        this.searchField.setText(initialString);

        // Select just the text after the prefix
        this.$searchField[0].setSelectionRange(prefix.length, initialString.length);
    };

    /**
     * Sets the dialog label based on the current plugin (if any) and the current query.
     * @private
     * @param {Object} plugin The current Quick Open plugin, or none if there is none.
     * @param {string} query The user's current query.
     */
    QuickNavigateDialog.prototype._updateDialogLabel = function (plugin, query) {
        var dialogLabel = "";
        if (plugin && plugin.label) {
            dialogLabel = plugin.label;
        } else {
            var prefix = (query.length > 0 ? query.charAt(0) : "");

            // Update the dialog label based on the current prefix.
            switch (prefix) {
                case ":":
                    dialogLabel = Strings.CMD_GOTO_LINE + "\u2026";
                    break;
                case "@":
                    dialogLabel = Strings.CMD_GOTO_DEFINITION + "\u2026";
                    break;
                case "#":
                    dialogLabel = Strings.CMD_GOTO_DEFINITION_PROJECT + "\u2026";
                    break;
                default:
                    dialogLabel = "";
                    break;
            }
        }
        $(".find-dialog-label", this.dialog).text(dialogLabel);
    };

    /**
     * Shows the search dialog and initializes the auto suggestion list with filenames from the current project
     * @private
     */
    QuickNavigateDialog.prototype.showDialog = function (prefix, initialString) {
        if (this.isOpen) {
            return;
        }
        this.isOpen = true;

        // Record current document & cursor pos so we can restore it if search is canceled
        // We record scroll pos *before* modal bar is opened since we're going to restore it *after* it's closed
        var curDoc = DocumentManager.getCurrentDocument();
        this._origDocPath = curDoc ? curDoc.file.fullPath : null;
        if (curDoc) {
            this._origSelections = EditorManager.getCurrentFullEditor().getSelections();
            this._origScrollPos = EditorManager.getCurrentFullEditor().getScrollPos();
        } else {
            this._origSelections = null;
            this._origScrollPos = null;
        }

        // Show the search bar
        var searchBarHTML = `<div align='right'>
            <div id="indexing-spinner" class="indexing-group">
                <div class="spinner inline spin"></div>
                <div id="indexing-spinner-message" class="indexing-message">${Strings.FIND_IN_FILES_INDEXING}</div>
            </div>
            <input type='text' autocomplete='off' spellcheck="false" id='quickOpenSearch'
            placeholder='${Strings.CMD_QUICK_OPEN}\u2026' style='width: 30em'>
            <span class='find-dialog-label'></span>
        </div>`;
        this.modalBar = new ModalBar(searchBarHTML, true);

        this.modalBar.on("close", this._handleCloseBar);

        this.$searchField = $("input#quickOpenSearch");
        this.$indexingSpinner = $("#indexing-spinner");

        this.searchField = new QuickSearchField(this.$searchField, {
            maxResults: 20,
            firstHighlightIndex: 0,
            verticalAdjust: this.modalBar.getRoot().outerHeight(),
            resultProvider: this._filterCallback,
            formatter: this._resultsFormatterCallback,
            onCommit: this._handleItemSelect,
            onHighlight: this._handleItemHighlight
        });

        // Return files that are non-binary, or binary files that have a custom viewer
        function _filter(file) {
            return !LanguageManager.getLanguageForPath(file.fullPath).isBinary() ||
                MainViewFactory.findSuitableFactoryForPath(file.fullPath);
        }

        // Start prefetching the file list, which will be needed the first time the user enters an un-prefixed query. If file index
        // caches are out of date, this list might take some time to asynchronously build, forcing searchFileList() to wait. In the
        // meantime we show our old, stale fileList (unless the user has switched projects and we cleared it).
        fileListPromise = ProjectManager.getAllFiles(_filter, true)
            .done(function (files) {
                this.$indexingSpinner.addClass("forced-hidden");
                fileList = files;
                fileListPromise = null;
                this._filenameMatcher.reset();
            }.bind(this));

        // Prepopulated query
        this.$searchField.focus();
        this.setSearchFieldValue(prefix, initialString);
    };

    function getCurrentEditorSelectedText() {
        var currentEditor = EditorManager.getActiveEditor();
        return (currentEditor && currentEditor.getSelectedText()) || "";
    }

    /**
     * Opens the Quick Open bar prepopulated with the given prefix (to select a mode) and optionally
     * with the given query text too. Updates text field contents if Quick Open already open.
     * @param {?string} prefix
     * @param {?string} initialString
     */
    function beginSearch(prefix, initialString) {
        function createDialog() {
            _curDialog = new QuickNavigateDialog();
            _curDialog.showDialog(prefix, initialString);
        }

        if (_curDialog) {
            if (_curDialog.isOpen) {
                // Just start a search using the existing dialog.
                _curDialog.setSearchFieldValue(prefix, initialString);
            } else {
                // The dialog is already closing. Wait till it's done closing,
                // then open a new dialog. (Calling close() again returns the
                // promise for the deferred that was already kicked off when it
                // started closing.)
                _curDialog.close().done(createDialog);
            }
        } else {
            createDialog();
        }
    }

    function doFileSearch() {
        beginSearch("", getCurrentEditorSelectedText());
    }

    function doGotoLine() {
        // TODO: Brackets doesn't support disabled menu items right now, when it does goto line and
        // goto definition should be disabled when there is not a current document
        if (DocumentManager.getCurrentDocument()) {
            beginSearch(":", "");
        }
    }

    function doDefinitionSearch() {
        if (DocumentManager.getCurrentDocument()) {
            beginSearch("@", getCurrentEditorSelectedText());
        }
    }

    function doDefinitionSearchInProject() {
        if (DocumentManager.getCurrentDocument()) {
            beginSearch("#", getCurrentEditorSelectedText());
        }
    }

    function _canHandleTrigger(trigger, plugins) {
        var retval = false;

        plugins.some(function (plugin, index) {
            var provider = plugin.provider;
            if (provider.match(trigger)) {
                retval = true;
                return true;
            }
        });

        return retval;
    }

    function _setMenuItemStateForLanguage(languageId) {
        var plugins = _providerRegistrationHandler.getProvidersForLanguageId(languageId);
        if (_canHandleTrigger("@", plugins)) {
            CommandManager.get(Commands.NAVIGATE_GOTO_DEFINITION).setEnabled(true);
        } else {
            CommandManager.get(Commands.NAVIGATE_GOTO_DEFINITION).setEnabled(false);
        }

        if (_canHandleTrigger("#", plugins)) {
            CommandManager.get(Commands.NAVIGATE_GOTO_DEFINITION_PROJECT).setEnabled(true);
        } else {
            CommandManager.get(Commands.NAVIGATE_GOTO_DEFINITION_PROJECT).setEnabled(false);
        }
    }

    // Listen for a change of project to invalidate our file list
    ProjectManager.on("projectOpen", function () {
        fileList = null;
    });

    MainViewManager.on("currentFileChange", function (event, newFile, newPaneId, oldFile, oldPaneId) {
        if (!newFile) {
            CommandManager.get(Commands.NAVIGATE_GOTO_DEFINITION).setEnabled(false);
            CommandManager.get(Commands.NAVIGATE_GOTO_DEFINITION_PROJECT).setEnabled(false);
            return;
        }

        var newFilePath = newFile.fullPath,
            newLanguage = LanguageManager.getLanguageForPath(newFilePath),
            newLanguageId = newLanguage.getId();

        if (newLanguage.isBinary()) {
            CommandManager.get(Commands.NAVIGATE_GOTO_DEFINITION).setEnabled(false);
            CommandManager.get(Commands.NAVIGATE_GOTO_DEFINITION_PROJECT).setEnabled(false);
            return;
        }

        _setMenuItemStateForLanguage(newLanguageId);

        DocumentManager.getDocumentForPath(newFilePath)
            .done(function (newDoc) {
                newDoc.off("languageChanged.quickFindDefinition");
                newDoc.on("languageChanged.quickFindDefinition", function () {
                    var changedLanguageId = LanguageManager.getLanguageForPath(newDoc.file.fullPath).getId();
                    _setMenuItemStateForLanguage(changedLanguageId);
                });
            }).fail(function (err) {
                console.error(err);
            });

        if (!oldFile) {
            return;
        }

        var oldFilePath = oldFile.fullPath;
        DocumentManager.getDocumentForPath(oldFilePath)
            .done(function (oldDoc) {
                oldDoc.off("languageChanged.quickFindDefinition");
            }).fail(function (err) {
                if (err !== FileSystemError.UNSUPPORTED_ENCODING) {
                    console.error(err);
                }
            });
    });

    CommandManager.register(Strings.CMD_QUICK_OPEN, Commands.NAVIGATE_QUICK_OPEN, doFileSearch);
    CommandManager.register(Strings.CMD_GOTO_DEFINITION, Commands.NAVIGATE_GOTO_DEFINITION, doDefinitionSearch);
    CommandManager.register(Strings.CMD_GOTO_DEFINITION_PROJECT, Commands.NAVIGATE_GOTO_DEFINITION_PROJECT, doDefinitionSearchInProject);
    CommandManager.register(Strings.CMD_GOTO_LINE, Commands.NAVIGATE_GOTO_LINE, doGotoLine);

    exports.beginSearch = beginSearch;
    exports.addQuickOpenPlugin = addQuickOpenPlugin;
    exports.highlightMatch = highlightMatch;
    exports.SymbolKind = SymbolKind;

    // Convenience exports for functions that most QuickOpen plugins would need.
    exports.stringMatch = StringMatch.stringMatch;
    exports.SearchResult = StringMatch.SearchResult;
    exports.basicMatchSort = StringMatch.basicMatchSort;
    exports.multiFieldSort = StringMatch.multiFieldSort;
});
