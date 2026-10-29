import { defineIntegration } from '../integration.js';
import { enableManagedTunnel } from '../utils/managedTunnelDefaults.js';
import { SERVE_TUNNEL_INTEGRATION_NAME } from '../utils/tunnel.js';
import { forwardTunnelRequest } from '../utils/tunnelForward.js';

const _serveTunnelIntegration = ((options = {}) => {
  return {
    name: SERVE_TUNNEL_INTEGRATION_NAME,
    forward: forwardTunnelRequest,
    setup(client) {
      enableManagedTunnel(client, options, forwardTunnelRequest);
    }
  };
});
const serveTunnelIntegration = defineIntegration(_serveTunnelIntegration);

export { serveTunnelIntegration };
//# sourceMappingURL=serveTunnel.js.map
