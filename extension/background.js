import { CONNECTION } from './config.generated.js';
import { createController } from './controller.js';
import { createConnection } from './connection.js';

let connection;
const controller = createController(chrome, event => connection?.send(event));
connection = createConnection(chrome, CONNECTION, controller);
