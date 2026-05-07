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
                        await vscode.workspace.applyEdit(editToggle);
                        break;
                    
                    case 'standby':
                        console.log('Standby command received for line:', message.line);
                        lineIndex = message.line;
                        lineText = document.lineAt(lineIndex).text;
                        newText = lineText.includes('[/]') ? lineText.replace('[/]', '[ ]') : lineText.includes('[x]') ? lineText.replace('[x]', '[/]') : lineText.replace('[ ]', '[/]');
                        
                        const editStandby = new vscode.WorkspaceEdit();
                        editStandby.replace(targetDocUri, document.lineAt(lineIndex).range, newText);
                        await vscode.workspace.applyEdit(editStandby);
                        break;

                    case 'move':
                        // On passe l'URI à moveTask pour qu'il soit autonome
                        await moveTask(targetDocUri, message.line, message.targetColumn);
                        break;

                    case 'filter': {
                        if (currentFilter !== '') {
                            currentFilter = '';
                            const filtered = filterColumns(parseMarkdown(document.getText()), currentFilter);
                            panel.webview.postMessage({ command: 'update', data: filtered });
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
                        panel.webview.postMessage({ command: 'update', data: filtered });
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
                panel.webview.postMessage({ command: 'update', data: filterColumns(newData, currentFilter) });
            }
        });

        panel.onDidDispose(() => { changeDocumentSubscription.dispose(); }, null, context.subscriptions);
    });
    
    context.subscriptions.push(disposable);
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
    await vscode.workspace.applyEdit(edit);
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
    await vscode.workspace.applyEdit(edit);
}

// Fonction Helper pour déplacer le texte
async function moveTask(docUri: vscode.Uri, lineIndex: number, targetColumn: string) {
    const doc = await vscode.workspace.openTextDocument(docUri);
    
    // 1. Identifier le bloc (tâche + lignes indentées)
    let endLine = lineIndex;
    while (endLine + 1 < doc.lineCount && 
          (doc.lineAt(endLine + 1).text.startsWith('  ') || doc.lineAt(endLine + 1).text.startsWith('\t'))) {
        endLine++;
    }
    
    const rangeToRemove = new vscode.Range(new vscode.Position(lineIndex, 0), new vscode.Position(endLine + 1, 0));
    const taskContent = doc.getText(rangeToRemove);

    // 2. Trouver la colonne cible
    let destLine = -1;
    for (let i = 0; i < doc.lineCount; i++) {
        const text = doc.lineAt(i).text;
        if (text.startsWith('###') && text.toLowerCase().includes(targetColumn.toLowerCase())) {
            destLine = i;
            break;
        }
    }

    if (destLine !== -1) {
        const edit = new vscode.WorkspaceEdit();
        // Pour éviter les problèmes d'index qui changent :
        // Si on déplace vers le bas, on insère d'abord puis on supprime.
        // Si on déplace vers le haut, c'est l'inverse. 
        // Le plus simple : faire deux edits séparés ou gérer les positions.
        const insertPos = new vscode.Position(destLine + 1, 0);
        edit.insert(docUri, insertPos, taskContent);
        edit.delete(docUri, rangeToRemove);
        
        await vscode.workspace.applyEdit(edit);
    }
}

function getWebviewContent(columns: any[]) {
    const renderTasks = (tasks: any[]) => tasks.map((t: any) => `
        <div class="task ${t.status}" 
             onclick="handleTaskClick(event, ${t.line})" 
             oncontextmenu="handleTaskClick(event, ${t.line})"
             draggable="true" 
             ondragstart="drag(event)" 
             data-line="${t.line}">
            ${t.priority === 1 ? '<span class="priority"> 🟡 </span>' : ''}
            ${t.priority === 2 ? '<span class="priority"> 🟠 </span>' : ''}
            ${t.priority === 3 ? '<span class="priority"> 🔴 </span>' : ''}
            <strong>${t.title}</strong>
            <div class="meta">
                ${t.estimate ? `<span>⏱️ ${t.estimate}</span>` : ''}
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
                    <h2>${col.name}</h2>
                    <span class="column-total">${calculateColumnTotal(col.tasks) ? `⏱️ ${calculateColumnTotal(col.tasks)}` : ''}</span>
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
            body { display: flex; gap: 20px; font-family: sans-serif; background: #222; color: white; padding: 20px; flex-wrap: wrap; }
            .column { flex: 1; background: #333; padding: 10px; border-radius: 8px; min-width: 250px; transition: background 0.2s; }
            .column-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
            .column-title { display: flex; align-items: center; gap: 15px; }
            .column-title h2 { margin: 0; }
            .column-total { font-size: 0.9em; opacity: 0.8; color: #aaa; white-space: nowrap; }
            .toolbar { display: flex; width: 100%; justify-content: flex-end; margin-bottom: 10px; }
            .filter-button { background: #ffffff; color: white; border: none; border-radius: 4px; padding: 8px 14px; cursor: pointer; font-size: 0.95em; }
            .filter-button:hover { background: #005a9e; }
            .add-task { background: #ffffff; color: white; border: none; border-radius: 4px; padding: 6px 10px; cursor: pointer; font-size: 0.9em; }
            .add-task:hover { background: #005a9e; }
            .column.drag-over { background: #444; border: 2px dashed #007acc; }
            .task { background: #444; margin: 10px 0; padding: 10px; border-radius: 4px; border-left: 4px solid #007acc; cursor: grab; }
            .task:active { cursor: grabbing; }
            .task.done { opacity: 0.6; border-left-color: #4caf50; text-decoration: line-through; color: #888; }
            .task.standby { opacity: 0.6; border-left-color: #fffb00; style: italic; }
            .tag { color: #ffab40; font-size: 0.8em; margin-left: 5px; }
            .date { color: #81c784; font-size: 0.8em; margin-left: 5px; }
            .meta { margin-top: 5px; font-size: 0.85em; opacity: 0.8; }
            .assignee { color: #4fc3f7; font-size: 0.8em; margin-left: 5px; font-weight: bold; }
            .priority { color: #ff5252; font-size: 1.0em; margin-left: 5px; }
        </style>
    </head>
    <body>
        <div class="toolbar">
            <button class="filter-button" onclick="filterTasks()">🔎</button>
        </div>
        <div id="kanban-container" style="display: flex; gap: 20px; width: 100%;">
            ${columnsHtml}
        </div>

        <script>
			const vscode = acquireVsCodeApi();

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

				if (line && targetColumn) {
					vscode.postMessage({ 
						command: 'move', 
						line: parseInt(line), 
						targetColumn: targetColumn 
					});
				}
			}

            window.addEventListener('message', event => {
                const message = event.data;
                if (message.command === 'update') {
                    updateUI(message.data); 
                }
            });

            function updateUI(columns) {
                const container = document.getElementById('kanban-container');
                let html = '';
                
                columns.forEach(col => {
                    html += '<div class="column" ondragover="allowDrop(event)" ondragleave="dragLeave(event)" ondrop="drop(event)" data-column="' + col.name + '">';
                    
                    const totalDuration = calculateColumnTotal(col.tasks);
                    console.log('Total duration for column', col.name, ':', totalDuration);
                    html += '<div class="column-header">';
                    html += '<div class="column-title">';
                    html += '<h2>' + col.name + '</h2>';
                    if (totalDuration) {
                        html += '<span class="column-total">⏱️ ' + totalDuration + '</span>';
                    }
                    html += '</div>';
                    html += '<button class="add-task" onclick="addTask(' + '\\'' + col.name + '\\'' + ')">➕</button>';
                    html += '</div>';

                    col.tasks.forEach(t => {
                        const statusClass = t.status || 'todo';
                        html += '<div class="task ' + statusClass + '" draggable="true" ondragstart="drag(event)" data-line="' + t.line + '" onclick="handleTaskClick(event, ' + t.line + ')" oncontextmenu="handleTaskClick(event, ' + t.line + ')">';
                        if (t.priority === 1) html += '<span class="priority"> ' + '🟡 ' + '</span>';
                        if (t.priority === 2) html += '<span class="priority"> ' + '🟠 ' + '</span>';
                        if (t.priority === 3) html += '<span class="priority"> ' + '🔴 ' + '</span>';
                        html += '<strong>' + t.title + '</strong>';
                        
                        // --- AJOUT DE LA META ZONE ---
                        html += '<div class="meta">';
                        if (t.estimate) html += '<span>⏱️ ' + t.estimate + ' </span>';
                        if (t.tag) html += '<span class="tag">#' + t.tag + ' </span>';
                        if (t.assignee) html += '<span class="assignee">@' + t.assignee + '</span>';
                        if (t.date) html += '<span class="date">📅 ' + t.date + '</span>';
                        html += '</div>';
                        
                        html += '</div>';
                    });
                    html += '</div>';
                });
                
                container.innerHTML = html;
            }
        </script>
    </body>
    </html>`;
}

// This method is called when your extension is deactivated
export function deactivate() {}
