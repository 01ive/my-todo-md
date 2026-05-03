export interface Task {
    id: string;
    title: string;
    status: 'todo' | 'done' | 'progress';
    estimate?: string;
    tag?: string;
    assignee?: string;
    date?: string;
    line: number;
    description: string[];
}

export interface Column {
    name: string;
    tasks: Task[];
}

export function parseMarkdown(content: string): Column[] {
    const lines = content.split('\n');
    const columns: Column[] = [];
    let currentColumn: Column | null = null;
    let currentTask: Task | null = null;

    lines.forEach((line, index) => {
        const trimmedLine = line.trim();

        // 1. Détection des colonnes (### Nom)
        if (line.startsWith('###')) {
            currentColumn = { name: line.replace('###', '').trim(), tasks: [] };
            columns.push(currentColumn);
            currentTask = null;
        } 
        // 2. Détection des tâches (- [ ])
        else if (currentColumn && trimmedLine.startsWith('- [')) {
            const statusChar = trimmedLine.substring(3, 4); // Capture le caractère entre [ ]
            let remainingText = trimmedLine.substring(5).trim(); // Le reste de la ligne

            // EXTRACTION DES ATTRIBUTS (Ordre libre)
            
            // Échéance (YYYY-MM-DD)
            const dateMatch = remainingText.match(/\d{4}-\d{2}-\d{2}/);
            const date = dateMatch ? dateMatch[0] : undefined;
            remainingText = remainingText.replace(/\d{4}-\d{2}-\d{2}/, '').trim();

            // Estimation (~durée)
            const estimateMatch = remainingText.match(/~([^\s]+)/);
            const estimate = estimateMatch ? estimateMatch[1] : undefined;
            remainingText = remainingText.replace(/~[^\s]+/, '').trim();

            // Tag (#tag)
            const tagMatch = remainingText.match(/#([^\s]+)/);
            const tag = tagMatch ? tagMatch[1] : undefined;
            remainingText = remainingText.replace(/#[^\s]+/, '').trim();

            // Assigné (@nom)
            const assigneeMatch = remainingText.match(/@([^\s]+)/);
            const assignee = assigneeMatch ? assigneeMatch[1] : undefined;
            remainingText = remainingText.replace(/@[^\s]+/, '').trim();

            currentTask = {
                id: Math.random().toString(36).substr(2, 9),
                title: remainingText, // Ce qu'il reste est le titre
                status: statusChar === 'x' ? 'done' : (statusChar === '/' ? 'progress' : 'todo'),
                line: index,
                estimate,
                tag,
                assignee,
                date,
                description: []
            };
            currentColumn.tasks.push(currentTask);
        }
        // 3. Détection des descriptions ou sous-tâches
        else if (currentTask && (line.startsWith('  ') || line.startsWith('\t'))) {
            currentTask.description.push(line.trim());
        }
    });

    return columns;
}