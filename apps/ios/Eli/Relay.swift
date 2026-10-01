import Foundation
import Network

/// Serves the remote Eli server on http://127.0.0.1:<port> through a raw TCP pipe.
/// Why: the microphone (getUserMedia) only works on a secure origin, and plain http to a Tailscale or LAN
/// address is not one, while 127.0.0.1 is. Nothing is rewritten, so the Host and Origin headers the server
/// checks stay consistent (both say 127.0.0.1), and host names work too (the server itself refuses them).
final class Relay {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "eli.relay")

    init(host: String, port: UInt16, onState: @escaping (NWListener.State) -> Void) throws {
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port) ?? .any)  // loopback only
        params.allowLocalEndpointReuse = true
        listener = try NWListener(using: params)
        listener.stateUpdateHandler = { state in DispatchQueue.main.async { onState(state) } }
        listener.newConnectionHandler = { [queue] inbound in
            let tcp = NWProtocolTCP.Options()
            tcp.connectionTimeout = 5  // an unreachable server fails fast instead of hanging the page
            let outbound = NWConnection(host: NWEndpoint.Host(host), port: NWEndpoint.Port(rawValue: port) ?? .any,
                                        using: NWParameters(tls: nil, tcp: tcp))
            outbound.stateUpdateHandler = { state in
                switch state {
                case .waiting, .failed: inbound.cancel(); outbound.cancel()  // unreachable: the page load fails
                default: break
                }
            }
            inbound.start(queue: queue)
            outbound.start(queue: queue)
            pipe(inbound, to: outbound)
            pipe(outbound, to: inbound)
        }
        listener.start(queue: queue)
    }

    deinit { listener.cancel() }
}

private func pipe(_ from: NWConnection, to: NWConnection) {
    from.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { data, _, isComplete, error in
        let finished = isComplete || error != nil
        to.send(content: data, contentContext: finished ? .finalMessage : .defaultMessage, isComplete: true,
                completion: .contentProcessed { sendError in
                    if finished || sendError != nil { from.cancel(); to.cancel() } else { pipe(from, to: to) }
                })
    }
}
