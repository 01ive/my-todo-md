import * as vscode from 'vscode';
import { parseMarkdown, Task, Column } from './parser';

// Fonction pour convertir une durée en minutes
function parseDuration(estimateStr: string): number {
    if (!estimateStr) return 0;
    
    const match = estimateStr.match(/^(\d+)([hmd])$/);
    if (!match) return 0;
    
    const value = parseInt(match[1], 10);
    const unit = match[2];
    
    switch (unit) {
        case 'h': return value * 60; // heures en minutes
        case 'm': return value; // minutes
        case 'd': return value * 8 * 60; // jours (8h) en minutes
        default: return 0;
    }
}

// Fonction pour formater une durée en minutes vers le format lisible
function formatDuration(minutes: number): string {
    if (minutes === 0) return '';
    
    let remaining = minutes;
    let days = Math.floor(remaining / (8 * 60));
    remaining -= days * 8 * 60;
    
    let hours = Math.floor(remaining / 60);
    remaining -= hours * 60;
    
    let mins = remaining;
    
    let parts: string[] = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (mins > 0) parts.push(`${mins}m`);
    
    return parts.join(' ');
}

// Fonction pour calculer la durée totale d'une colonne
function calculateColumnTotal(tasks: Task[]): string {
    let totalMinutes = 0;
    tasks.forEach(task => {
        if (task.estimate) {
            totalMinutes += parseDuration(task.estimate);
        }
    });
    return formatDuration(totalMinutes);
}

function getTaskSpentMinutes(task: Task): number {
    if (task.timeSpent) {
        return parseDuration(task.timeSpent);
    }
    if (task.completion !== undefined && task.estimate) {
        return Math.round(parseDuration(task.estimate) * task.completion / 100);
    }
    return 0;
}

function calculateColumnSpentTotal(tasks: Task[]): string {
    return formatDuration(tasks.reduce((total, task) => total + getTaskSpentMinutes(task), 0));
}

const ganttDayMs = 24 * 60 * 60 * 1000;

export function buildGanttTasks(columns: Column[]): { title: string; start: number; end: number }[] {
    return columns.flatMap(column => column.tasks.flatMap(task => {
        if (task.status === 'done' || !task.date || !task.estimate) {
            return [];
        }

        const dateMatch = task.date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        const durationDays = parseDuration(task.estimate) / (8 * 60);
        if (!dateMatch || durationDays <= 0) {
            return [];
        }

        const end = Date.UTC(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3])) + ganttDayMs;
        const dueDate = new Date(end - ganttDayMs);
        if (dueDate.getUTCFullYear() !== Number(dateMatch[1]) ||
            dueDate.getUTCMonth() !== Number(dateMatch[2]) - 1 ||
            dueDate.getUTCDate() !== Number(dateMatch[3])) {
            return [];
        }

        return [{ title: task.title, start: end - durationDays * ganttDayMs, end }];
    }));
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[character]!);
}

function renderGanttHtml(columns: Column[]): string {
    const tasks = buildGanttTasks(columns);
    if (tasks.length === 0) {
        return '<p class="gantt-empty">Aucune tâche avec date et durée estimée.</p>';
    }

    const rangeStart = Math.floor(Math.min(...tasks.map(task => task.start)) / ganttDayMs) * ganttDayMs;
    const rangeEnd = Math.max(...tasks.map(task => task.end));
    const dayCount = Math.ceil((rangeEnd - rangeStart) / ganttDayMs);
    const dates = Array.from({ length: dayCount }, (_, index) => {
        const date = new Date(rangeStart + index * ganttDayMs);
        return `<div class="gantt-day">${date.toISOString().slice(5, 10)}</div>`;
    }).join('');
    const rows = tasks.map(task => {
        const left = ((task.start - rangeStart) / (dayCount * ganttDayMs)) * 100;
        const width = ((task.end - task.start) / (dayCount * ganttDayMs)) * 100;
        return `<div class="gantt-row"><div class="gantt-task-label" title="${escapeHtml(task.title)}">${escapeHtml(task.title)}</div><div class="gantt-track"><div class="gantt-bar" style="left:${left}%;width:${width}%"></div></div></div>`;
    }).join('');

    return `<div class="gantt-chart" style="--day-count:${dayCount};--timeline-width:${dayCount * 44}px"><div class="gantt-row gantt-header"><div class="gantt-task-label">Tâche</div><div class="gantt-track">${dates}</div></div>${rows}</div>`;
}

function filterColumns(columns: Column[], filter: string): Column[] {
    if (!filter || filter.trim() === '') {
        return columns;
    }

    const lowerFilter = filter.trim().toLowerCase();
    return columns
        .map(col => ({
            ...col,
            tasks: col.tasks.filter(task => {
                const values = [
                    task.title,
                    task.estimate,
                    task.timeSpent ? `$${task.timeSpent}` : undefined,
                    task.completion !== undefined ? `$${task.completion}%` : undefined,
                    task.tag ? `#${task.tag}` : undefined,
                    task.assignee ? `@${task.assignee}` : undefined,
                    task.date,
                    task.status,
                    ...(task.description || [])
                ].filter((value): value is string => typeof value === 'string' && value.length > 0);

                return values.some(value => value.toLowerCase().includes(lowerFilter));
            })
        }))
        .filter(col => col.tasks.length > 0);
}

export function activate(context: vscode.ExtensionContext) {
    let disposable = vscode.commands.registerCommand('my-todo-md.openKanban', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        // On garde une référence fixe au document
        const targetDocUri = editor.document.uri;
        let currentFilter = '';

        const panel = vscode.window.createWebviewPanel(
            'todoKanban',
            'Mon Kanban: ' + editor.document.fileName.split('/').pop(),
            vscode.ViewColumn.Two,
            { enableScripts: true }
        );

        const initialData = parseMarkdown(editor.document.getText());
        panel.webview.html = getWebviewContent(filterColumns(initialData, currentFilter));

        panel.webview.onDidReceiveMessage(
            async message => {
                // On utilise targetDocUri plutôt que activeTextEditor
                const document = await vscode.workspace.openTextDocument(targetDocUri);
                
                let newText: string;
                let lineIndex: number;
                let lineText: string;

                switch (message.command) { 
                    case 'toggle':
                        console.log('Toggle status for line:', message.line);
                        lineIndex = message.line;
                        lineText = document.lineAt(lineIndex).text;
                        newText = lineText.includes('[x]') ? lineText.replace('[x]', '[ ]') : lineText.includes('[/]') ? lineText.replace('[/]', '[ ]') : lineText.replace('[ ]', '[x]'); // Toggle entre todo, done et standby
                        
                        const editToggle = new vscode.WorkspaceEdit();
                        editToggle.replace(targetDocUri, document.lineAt(lineIndex).range, newText);
                        await applyEditAndSave(targetDocUri, editToggle);
                        break;
                    
                    case 'standby':
                        console.log('Standby command received for line:', message.line);
                        lineIndex = message.line;
                        lineText = document.lineAt(lineIndex).text;
                        newText = lineText.includes('[/]') ? lineText.replace('[/]', '[ ]') : lineText.includes('[x]') ? lineText.replace('[x]', '[/]') : lineText.replace('[ ]', '[/]');
                        
                        const editStandby = new vscode.WorkspaceEdit();
                        editStandby.replace(targetDocUri, document.lineAt(lineIndex).range, newText);
                        await applyEditAndSave(targetDocUri, editStandby);
                        break;

                    case 'move':
                        // On passe l'URI à moveTask pour qu'il soit autonome
                        await moveTask(targetDocUri, message.line, message.targetColumn, message.targetLine, message.insertAfter);
                        break;

                    case 'filter': {
                        if (currentFilter !== '') {
                            currentFilter = '';
                            const filtered = filterColumns(parseMarkdown(document.getText()), currentFilter);
                            panel.webview.postMessage({ command: 'update', data: filtered, ganttHtml: renderGanttHtml(filtered) });
                            break;
                        }

                        const filterText = await vscode.window.showInputBox({
                            prompt: 'Filtrer les tâches contenant ce texte',
                            placeHolder: 'Texte de recherche (laisser vide pour réinitialiser)',
                            value: currentFilter
                        });

                        if (filterText === undefined) {
                            break; // annulation : ne rien changer
                        }

                        currentFilter = filterText.trim();
                        const filtered = filterColumns(parseMarkdown(document.getText()), currentFilter);
                        panel.webview.postMessage({ command: 'update', data: filtered, ganttHtml: renderGanttHtml(filtered) });
                        break;
                    }

                    case 'add':
                        console.log('Add command received for column:', message.column);
                        await addTask(targetDocUri, message.column);
                        break;

                    case 'edit':
                        console.log('Edit command received for line:', message.line);
                        await editTask(targetDocUri, message.line);
                        break;
                }
            },
            undefined,
            context.subscriptions
        );

        const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document === editor.document) {
                const newData = parseMarkdown(e.document.getText());
                const filtered = filterColumns(newData, currentFilter);
                panel.webview.postMessage({ command: 'update', data: filtered, ganttHtml: renderGanttHtml(filtered) });
            }
        });

        panel.onDidDispose(() => { changeDocumentSubscription.dispose(); }, null, context.subscriptions);
    });
    
    context.subscriptions.push(disposable);
}

// Fonction helper pour appliquer une édition et sauvegarder le fichier
async function applyEditAndSave(docUri: vscode.Uri, edit: vscode.WorkspaceEdit) {
    await vscode.workspace.applyEdit(edit);
    
    // Ouvrir le document et le sauvegarder
    const document = await vscode.workspace.openTextDocument(docUri);
    await document.save();
}

async function addTask(docUri: vscode.Uri, columnName: string) {
    const taskTitle = await vscode.window.showInputBox({
        prompt: `Titre de la nouvelle tâche pour « ${columnName} »`,
        placeHolder: 'Exemple : Préparer la réunion',
        validateInput: value => value.trim().length === 0 ? 'Le titre ne peut pas être vide' : undefined
    });

    if (!taskTitle) {
        return;
    }

    const doc = await vscode.workspace.openTextDocument(docUri);
    let insertLine = doc.lineCount;
    let foundColumnLine = -1;

    for (let i = 0; i < doc.lineCount; i++) {
        const text = doc.lineAt(i).text;
        if (text.startsWith('###') && text.replace('###', '').trim().toLowerCase() === columnName.toLowerCase()) {
            foundColumnLine = i;
            insertLine = i+1;
            continue;
        }
    }

    const edit = new vscode.WorkspaceEdit();
    edit.insert(docUri, new vscode.Position(insertLine, 0), `- [ ] ${taskTitle}\n`);
    await applyEditAndSave(docUri, edit);
}

async function editTask(docUri: vscode.Uri, lineIndex: number) {
    const doc = await vscode.workspace.openTextDocument(docUri);
    const lineText = doc.lineAt(lineIndex).text;

    // Extraire le titre actuel de la tâche
    const titleMatch = lineText.match(/^- \[[ x\/]\] (.*)$/);
    const currentTitle = titleMatch ? titleMatch[1].trim() : '';

    const newTitle = await vscode.window.showInputBox({
        prompt: 'Modifier le titre de la tâche',
        placeHolder: 'Nouveau titre',
        value: currentTitle,
        validateInput: value => value.trim().length === 0 ? 'Le titre ne peut pas être vide' : undefined
    });

    if (!newTitle || newTitle.trim() === currentTitle) {
        return; // Annulation ou pas de changement
    }

    // Remplacer le titre dans la ligne
    const newLineText = lineText.replace(currentTitle, newTitle.trim());
    const edit = new vscode.WorkspaceEdit();
    edit.replace(docUri, doc.lineAt(lineIndex).range, newLineText);
    await applyEditAndSave(docUri, edit);
}

// Fonction Helper pour déplacer le texte
async function moveTask(docUri: vscode.Uri, lineIndex: number, targetColumn: string, targetLine?: number, insertAfter = false) {
    const doc = await vscode.workspace.openTextDocument(docUri);
    
    const findTaskEndLine = (startLine: number) => {
        let endLine = startLine;
        while (endLine + 1 < doc.lineCount &&
              (doc.lineAt(endLine + 1).text.startsWith('  ') || doc.lineAt(endLine + 1).text.startsWith('\t'))) {
            endLine++;
        }
        return endLine;
    };

    const endLine = findTaskEndLine(lineIndex);
    
    const rangeToRemove = new vscode.Range(new vscode.Position(lineIndex, 0), new vscode.Position(endLine + 1, 0));
    const taskContent = doc.getText(rangeToRemove);

    let destinationHeadingLine = -1;
    for (let i = 0; i < doc.lineCount; i++) {
        const text = doc.lineAt(i).text;
        if (text.startsWith('###') && text.replace('###', '').trim().toLowerCase() === targetColumn.toLowerCase()) {
            destinationHeadingLine = i;
            break;
        }
    }

    if (destinationHeadingLine === -1) {
        return;
    }

    let insertLine = destinationHeadingLine + 1;
    if (targetLine !== undefined && targetLine !== null && targetLine >= 0 && targetLine < doc.lineCount) {
        if (targetLine >= lineIndex && targetLine <= endLine) {
            return;
        }
        insertLine = insertAfter ? findTaskEndLine(targetLine) + 1 : targetLine;
    } else {
        for (let i = destinationHeadingLine + 1; i < doc.lineCount && !doc.lineAt(i).text.startsWith('###'); i++) {
            if (doc.lineAt(i).text.trim().startsWith('- [')) {
                insertLine = findTaskEndLine(i) + 1;
                i = insertLine - 1;
            }
        }
    }

    if (insertLine === lineIndex || insertLine === endLine + 1) {
        return;
    }

    const edit = new vscode.WorkspaceEdit();
    edit.insert(docUri, new vscode.Position(insertLine, 0), taskContent);
    edit.delete(docUri, rangeToRemove);
    await applyEditAndSave(docUri, edit);
}

function getWebviewContent(columns: any[]) {
    const renderTasks = (tasks: any[]) => tasks.map((t: any) => `
        <div class="task ${t.status}" 
             onclick="handleTaskClick(event, ${t.line})" 
             oncontextmenu="handleTaskClick(event, ${t.line})"
             draggable="true" 
             ondragstart="drag(event)" 
               data-line="${t.line}"
               data-date="${t.date || ''}">
            ${t.priority === 1 ? '<span class="priority"> 🟡 </span>' : ''}
            ${t.priority === 2 ? '<span class="priority"> 🟠 </span>' : ''}
            ${t.priority === 3 ? '<span class="priority"> 🔴 </span>' : ''}
            <strong>${t.title}</strong>
            <div class="meta">
                ${t.estimate ? `<span>⏱️ ${t.estimate}</span>` : ''}
                ${t.timeSpent ? `<span class="time-spent">⏳ ${t.timeSpent}</span>` : ''}
                ${t.completion !== undefined ? `<span class="time-spent">⏳ ${t.completion}%${t.estimate ? ` · ${formatDuration(Math.round(parseDuration(t.estimate) * t.completion / 100))}` : ''}</span>` : ''}
                ${t.tag ? `<span class="tag">#${t.tag}</span>` : ''}
                ${t.assignee ? `<span class="assignee">@${t.assignee}</span>` : ''}
                ${t.date ? `<span class="date">📅 ${t.date}</span>` : ''}
            </div>
        </div>
    `).join('');

    const columnsHtml = columns.map(col => `
        <div class="column" 
             ondragover="allowDrop(event)" 
             ondragleave="dragLeave(event)"
             ondrop="drop(event)" 
             data-column="${col.name}">
            <div class="column-header">
                <div class="column-title">
                    <h2 role="button" tabindex="0" aria-expanded="true" onclick="toggleColumn(this)" onkeydown="handleColumnTitleKeydown(event, this)">${col.name}</h2>
                    <span class="column-total">${calculateColumnTotal(col.tasks) ? `⏱️ ${calculateColumnTotal(col.tasks)}` : ''}${calculateColumnSpentTotal(col.tasks) ? ` <span class="spent-total">⏳ ${calculateColumnSpentTotal(col.tasks)}</span>` : ''}</span>
                </div>
                <button class="add-task" onclick="addTask('${col.name}')">➕</button>
            </div>
            <div class="task-list">
                ${renderTasks(col.tasks)}
            </div>
        </div>
    `).join('');

    return `<!DOCTYPE html>
    <html>
    <head>
        <style>
            body { display: flex; gap: 20px; font-family: sans-serif; background: #222; color: white; padding: 20px; flex-wrap: wrap; box-sizing: border-box; }
            .gantt-section { width: 100%; min-width: 0; padding-bottom: 14px; border-bottom: 1px solid #555; }
            .gantt-section h2 { margin: 0 0 10px; font-size: 1.1em; }
            .gantt-scroll { overflow-x: auto; }
            .gantt-chart { min-width: max-content; }
            .gantt-row { display: grid; grid-template-columns: 220px var(--timeline-width); min-height: 34px; }
            .gantt-task-label { overflow: hidden; padding: 8px 10px 8px 0; text-overflow: ellipsis; white-space: nowrap; }
            .gantt-track { position: relative; display: grid; grid-template-columns: repeat(var(--day-count), 44px); }
            .gantt-header { min-height: 30px; color: #aaa; font-size: 0.8em; }
            .gantt-header .gantt-task-label { font-weight: bold; }
            .gantt-day { box-sizing: border-box; padding: 7px 0; border-left: 1px solid #444; text-align: center; }
            .gantt-bar { position: absolute; top: 7px; bottom: 7px; min-width: 3px; border-radius: 3px; background: #1685b8; }
            .gantt-empty { margin: 8px 0; color: #aaa; }
            .column { box-sizing: border-box; flex: 1 1 0; background: #333; padding: 10px; border-radius: 8px; min-width: 0; transition: background 0.2s, flex-basis 0.2s; }
            .column-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
            .column-title { display: flex; align-items: center; gap: 15px; }
            .column-title h2 { margin: 0; cursor: pointer; }
            .column-title h2:focus-visible { outline: 2px solid #007acc; outline-offset: 3px; }
            .column-total { font-size: 0.9em; opacity: 0.8; color: #aaa; white-space: nowrap; }
            .spent-total { margin-left: 8px; }
            .toolbar { display: flex; width: 100%; justify-content: flex-end; margin-bottom: 10px; }
            .filter-button { background: #ffffff; color: white; border: none; border-radius: 4px; padding: 8px 14px; cursor: pointer; font-size: 0.95em; }
            .filter-button:hover { background: #005a9e; }
            .add-task { background: #ffffff; color: white; border: none; border-radius: 4px; padding: 6px 10px; cursor: pointer; font-size: 0.9em; }
            .add-task:hover { background: #005a9e; }
            .column.drag-over { background: #444; border: 2px dashed #007acc; }
            .task { background: #444; margin: 10px 0; padding: 10px; border-radius: 4px; border-left: 4px solid #007acc; cursor: grab; }
            .task:active { cursor: grabbing; }
            .task.deadline-overdue { outline: 1px solid #ff5252; outline-offset: -1px; }
            .task.deadline-today { outline: 1px solid #ffeb3b; outline-offset: -1px; }
            .task.done { opacity: 0.6; border-left-color: #4caf50; text-decoration: line-through; color: #888; }
            .task.standby { opacity: 0.6; border-left-color: #fffb00; style: italic; }
            .tag { color: #ffab40; font-size: 0.8em; margin-left: 5px; }
            .date { color: #81c784; font-size: 0.8em; margin-left: 5px; }
            .meta { margin-top: 5px; font-size: 0.85em; opacity: 0.8; }
            .assignee { color: #4fc3f7; font-size: 0.8em; margin-left: 5px; font-weight: bold; }
            .priority { color: #ff5252; font-size: 1.0em; margin-left: 5px; }
            #kanban-container { flex-wrap: nowrap; align-items: stretch; min-width: 0; }
            .column.collapsed { flex: 0 0 auto; width: max-content; }
            .column.collapsed .column-header,
            .column.collapsed .column-title { display: block; }
            .column.collapsed .column-title h2 { white-space: nowrap; }
            .column.collapsed .column-total,
            .column.collapsed .add-task,
            .column.collapsed .meta,
            .column.collapsed .priority { display: none; }
            .column.collapsed .task { min-width: 0; }
            .column.collapsed .task strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        </style>
    </head>
    <body>
        <section class="gantt-section">
            <h2>Planning</h2>
            <div id="gantt-container" class="gantt-scroll">${renderGanttHtml(columns)}</div>
        </section>
        <div class="toolbar">
            <button class="filter-button" onclick="filterTasks()">🔎</button>
        </div>
        <div id="kanban-container" style="display: flex; gap: 20px; width: 100%;">
            ${columnsHtml}
        </div>

        <script>
			const vscode = acquireVsCodeApi();
            const collapsedColumns = new Set();
            const manuallyToggledColumns = new Set();

            // Fonction pour convertir une durée en minutes
            function parseDuration(estimateStr) {
                console.log('Parsing duration:', estimateStr);
                if (!estimateStr) return 0;
                
                const match = estimateStr.match(/^(\\d+)([hmd])$/);
                if (!match) return 0;
                
                const value = parseInt(match[1], 10);
                const unit = match[2];
                
                switch (unit) {
                    case 'h': return value * 60; // heures en minutes
                    case 'm': return value; // minutes
                    case 'd': return value * 8 * 60; // jours (8h) en minutes
                    default: return 0;
                }
            }

            // Fonction pour formater une durée en minutes vers le format lisible
            function formatDuration(minutes) {
                console.log('Formatting duration:', minutes);
                if (minutes === 0) return '';
                
                let remaining = minutes;
                let days = Math.floor(remaining / (8 * 60));
                remaining -= days * 8 * 60;
                
                let hours = Math.floor(remaining / 60);
                remaining -= hours * 60;
                
                let mins = remaining;
                
                let parts = [];
                if (days > 0) parts.push(days + 'd');
                if (hours > 0) parts.push(hours + 'h');
                if (mins > 0) parts.push(mins + 'm');
                
                return parts.join(' ');
            }

            function getTaskSpentMinutes(task) {
                if (task.timeSpent) return parseDuration(task.timeSpent);
                if (task.completion !== undefined && task.estimate) {
                    return Math.round(parseDuration(task.estimate) * task.completion / 100);
                }
                return 0;
            }

            function calculateColumnSpentTotal(tasks) {
                const totalMinutes = tasks.reduce((total, task) => total + getTaskSpentMinutes(task), 0);
                return formatDuration(totalMinutes);
            }

            function renderColumnTotals(tasks) {
                const estimated = calculateColumnTotal(tasks);
                const spent = calculateColumnSpentTotal(tasks);
                return (estimated ? '⏱️ ' + estimated : '') + (spent ? '<span class="spent-total">⏳ ' + spent + '</span>' : '');
            }

            function renderTaskSpent(task) {
                if (task.timeSpent) return '<span class="time-spent">⏳ ' + task.timeSpent + '</span>';
                if (task.completion !== undefined) {
                    const calculated = task.estimate ? formatDuration(getTaskSpentMinutes(task)) : '';
                    return '<span class="time-spent">⏳ ' + task.completion + '%' + (calculated ? ' · ' + calculated : '') + '</span>';
                }
                return '';
            }

            function updateDeadlineStyles() {
                const now = new Date();
                const today = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');

                document.querySelectorAll('.task[data-date]').forEach(task => {
                    const date = task.getAttribute('data-date');
                    const isDone = task.classList.contains('done');
                    task.classList.toggle('deadline-overdue', !isDone && Boolean(date) && date < today);
                    task.classList.toggle('deadline-today', !isDone && Boolean(date) && date === today);
                });
            }

            function handleColumnTitleKeydown(event, title) {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    toggleColumn(title);
                }
            }

            function toggleColumn(title) {
                const column = title.closest('.column');
                const name = column.getAttribute('data-column');
                manuallyToggledColumns.add(name);
                if (column.classList.contains('collapsed')) {
                    collapsedColumns.delete(name);
                } else {
                    collapsedColumns.add(name);
                }
                applyCollapsedColumns();
            }

            function applyCollapsedColumns() {
                const columns = document.querySelectorAll('.column');
                columns.forEach((column, index) => {
                    const name = column.getAttribute('data-column');
                    const isDefaultCollapsed = index === 0 || index === columns.length - 1;
                    const isCollapsed = manuallyToggledColumns.has(name)
                        ? collapsedColumns.has(name)
                        : isDefaultCollapsed;
                    column.classList.toggle('collapsed', isCollapsed);
                    const title = column.querySelector('.column-title h2');
                    title.setAttribute('aria-expanded', String(!isCollapsed));
                    column.style.width = isCollapsed ? (title.scrollWidth + 20) + 'px' : '';
                });
            }

            // Fonction pour calculer la durée totale d'une colonne
            function calculateColumnTotal(tasks) {
                console.log('Calculating total for tasks:', tasks);
                let totalMinutes = 0;
                tasks.forEach(task => {
                    if (task.estimate) {
                        totalMinutes += parseDuration(task.estimate);
                    }
                });
                console.log('Total minutes:', totalMinutes);
                return formatDuration(totalMinutes);
            }

            function handleTaskClick(ev, line) {
                ev.preventDefault(); // Empêche le menu contextuel de s'ouvrir
                console.log('Task click event:', ev.type, 'ctrlKey:', ev.ctrlKey, 'on line:', line);
                if (ev.type === 'click' && ev.ctrlKey === false) {
                    toggleTask(line);
                } else if (ev.type === 'contextmenu') {
                    standbyTask(line);
                } else if (ev.type === 'click' && ev.ctrlKey === true) {
                    editTask(line);
                }
            }

			function toggleTask(line) {
				// On évite que le clic ne soit déclenché pendant un drag
				vscode.postMessage({ command: 'toggle', line: line });
			}
            
            function standbyTask(line) {
				// On évite que le clic ne soit déclenché pendant un drag
				vscode.postMessage({ command: 'standby', line: line });
			}

            function editTask(line) {
				// Éditer la tâche
				vscode.postMessage({ command: 'edit', line: line });
			}

            function addTask(column) {
                console.log('Add task to column:', column);
                vscode.postMessage({ command: 'add', column: column });
            }

            function filterTasks() {
                vscode.postMessage({ command: 'filter' });
            }

			function allowDrop(ev) {
				ev.preventDefault();
				ev.currentTarget.classList.add('drag-over');
			}

			function dragLeave(ev) {
				ev.currentTarget.classList.remove('drag-over');
			}

			function drag(ev) {
				// UTILISER currentTarget pour être sûr d'avoir le div .task
				ev.dataTransfer.setData("line", ev.currentTarget.getAttribute("data-line"));
				ev.dataTransfer.effectAllowed = "move";
			}

			function drop(ev) {
				ev.preventDefault();
				const columnElt = ev.currentTarget;
				columnElt.classList.remove('drag-over');
				
				const line = ev.dataTransfer.getData("line");
				const targetColumn = columnElt.getAttribute("data-column");
                const targetElement = ev.target instanceof Element ? ev.target : null;
                const targetTask = targetElement ? targetElement.closest('.task') : null;
                let targetLine = null;
                let insertAfter = false;

                if (targetTask && columnElt.contains(targetTask)) {
                    targetLine = Number(targetTask.getAttribute('data-line'));
                    const bounds = targetTask.getBoundingClientRect();
                    insertAfter = ev.clientY >= bounds.top + bounds.height / 2;
                }

                if (line !== '' && targetColumn) {
                    vscode.postMessage({
                        command: 'move',
                        line: parseInt(line),
                        targetColumn: targetColumn,
                        targetLine: targetLine,
                        insertAfter: insertAfter
                    });
                }
			}

            window.addEventListener('message', event => {
                const message = event.data;
                if (message.command === 'update') {
                    updateUI(message.data); 
                    updateGantt(message.ganttHtml);
                }
            });

            function updateGantt(html) {
                document.getElementById('gantt-container').innerHTML = html;
            }

            function updateUI(columns) {
                const container = document.getElementById('kanban-container');
                let html = '';
                
                columns.forEach(col => {
                    html += '<div class="column" ondragover="allowDrop(event)" ondragleave="dragLeave(event)" ondrop="drop(event)" data-column="' + col.name + '">';
                    
                    const totalDuration = calculateColumnTotal(col.tasks);
                    html += '<div class="column-header">';
                    html += '<div class="column-title">';
                    html += '<h2 role="button" tabindex="0" aria-expanded="true" onclick="toggleColumn(this)" onkeydown="handleColumnTitleKeydown(event, this)">' + col.name + '</h2>';
                    const columnTotals = renderColumnTotals(col.tasks);
                    if (columnTotals) html += '<span class="column-total">' + columnTotals + '</span>';
                    html += '</div>';
                    html += '<button class="add-task" onclick="addTask(' + '\\'' + col.name + '\\'' + ')">➕</button>';
                    html += '</div>';

                    col.tasks.forEach(t => {
                        const statusClass = t.status || 'todo';
                        html += '<div class="task ' + statusClass + '" draggable="true" ondragstart="drag(event)" data-line="' + t.line + '" data-date="' + (t.date || '') + '" onclick="handleTaskClick(event, ' + t.line + ')" oncontextmenu="handleTaskClick(event, ' + t.line + ')">';
                        if (t.priority === 1) html += '<span class="priority"> ' + '🟡 ' + '</span>';
                        if (t.priority === 2) html += '<span class="priority"> ' + '🟠 ' + '</span>';
                        if (t.priority === 3) html += '<span class="priority"> ' + '🔴 ' + '</span>';
                        html += '<strong>' + t.title + '</strong>';
                        
                        // --- AJOUT DE LA META ZONE ---
                        html += '<div class="meta">';
                        if (t.estimate) html += '<span>⏱️ ' + t.estimate + ' </span>';
                        html += renderTaskSpent(t);
                        if (t.tag) html += '<span class="tag">#' + t.tag + ' </span>';
                        if (t.assignee) html += '<span class="assignee">@' + t.assignee + '</span>';
                        if (t.date) html += '<span class="date">📅 ' + t.date + '</span>';
                        html += '</div>';
                        
                        html += '</div>';
                    });
                    html += '</div>';
                });
                
                container.innerHTML = html;
                applyCollapsedColumns();
                updateDeadlineStyles();
            }

            applyCollapsedColumns();
            updateDeadlineStyles();
            setInterval(updateDeadlineStyles, 60 * 1000);
        </script>
    </body>
    </html>`;
}

// This method is called when your extension is deactivated
export function deactivate() {}
