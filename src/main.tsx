import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DesktopApp } from './desktop/App';
import './desktop/styles.css';
import './desktop/workspaces.css';
import './desktop/assistant.css';
import './desktop/workspace.css';
import './desktop/dashboard.css';
import './desktop/dashboard-supporting.css';
import './desktop/dashboard-usage.css';
import './desktop/inbox.css';
import './desktop/text-selection.css';
import './desktop/dashboard-panels.css';
import './desktop/dashboard-evolution.css';

createRoot(document.getElementById('root')!).render(<StrictMode><DesktopApp /></StrictMode>);
