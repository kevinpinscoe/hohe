import { render } from 'preact';
import { App } from './app';
import { Store } from './store';
import { registerServiceWorker } from './update';
import './styles.css';

const store = new Store();
render(<App store={store} />, document.getElementById('app')!);
void store.start();
void registerServiceWorker();
