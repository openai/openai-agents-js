"""Test-only OTLP receiver using the official protobuf messages and gRPC services."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import ssl
import threading

import grpc
from google.protobuf.json_format import MessageToDict, Parse
from opentelemetry.proto.collector.logs.v1 import logs_service_pb2 as logs, logs_service_pb2_grpc
from opentelemetry.proto.collector.metrics.v1 import metrics_service_pb2 as metrics, metrics_service_pb2_grpc
from opentelemetry.proto.collector.trace.v1 import trace_service_pb2 as traces, trace_service_pb2_grpc


lock = threading.Lock()


def emit(value):
    with lock:
        print(json.dumps(value), flush=True)


def record(signal, request, headers, client_authenticated=None):
    value = {"signal": signal, "headers": dict(headers), "payload": MessageToDict(request)}
    if client_authenticated is not None:
        value["clientAuthenticated"] = client_authenticated
    emit(value)


class Logs(logs_service_pb2_grpc.LogsServiceServicer):
    def Export(self, request, context):
        record("logs", request, context.invocation_metadata())
        return logs.ExportLogsServiceResponse()


class Traces(trace_service_pb2_grpc.TraceServiceServicer):
    def Export(self, request, context):
        record("traces", request, context.invocation_metadata())
        return traces.ExportTraceServiceResponse()


class Metrics(metrics_service_pb2_grpc.MetricsServiceServicer):
    def Export(self, request, context):
        record("metrics", request, context.invocation_metadata())
        return metrics.ExportMetricsServiceResponse()


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        signal = self.path.rsplit("/", 1)[-1]
        request_type, response_type = {
            "logs": (logs.ExportLogsServiceRequest, logs.ExportLogsServiceResponse),
            "traces": (traces.ExportTraceServiceRequest, traces.ExportTraceServiceResponse),
            "metrics": (metrics.ExportMetricsServiceRequest, metrics.ExportMetricsServiceResponse),
        }[signal]
        request = request_type()
        data = self.rfile.read(int(self.headers["content-length"]))
        is_json = "json" in self.headers.get("content-type", "")
        if is_json:
            Parse(data.decode(), request)
        else:
            request.ParseFromString(data)
        client_authenticated = isinstance(self.connection, ssl.SSLSocket) and bool(self.connection.getpeercert())
        record(signal, request, self.headers.items(), client_authenticated)
        data = b"{}" if is_json else response_type().SerializeToString()
        self.send_response(200)
        self.send_header("content-type", "application/json" if is_json else "application/x-protobuf")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_args):
        pass


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--transport", choices=["http", "grpc"], required=True)
    parser.add_argument("--certificate")
    parser.add_argument("--key")
    parser.add_argument("--ca")
    parser.add_argument("--also-plain-http", action="store_true")
    args = parser.parse_args()
    secure = bool(args.certificate)
    assert not args.also_plain_http or (args.transport == "http" and secure)
    if args.transport == "grpc":
        server = grpc.server(ThreadPoolExecutor(max_workers=4))
        logs_service_pb2_grpc.add_LogsServiceServicer_to_server(Logs(), server)
        trace_service_pb2_grpc.add_TraceServiceServicer_to_server(Traces(), server)
        metrics_service_pb2_grpc.add_MetricsServiceServicer_to_server(Metrics(), server)
        if secure:
            with open(args.key, "rb") as file:
                key = file.read()
            with open(args.certificate, "rb") as file:
                certificate = file.read()
            with open(args.ca, "rb") if args.ca else open(args.certificate, "rb") as file:
                ca = file.read()
            credentials = grpc.ssl_server_credentials([(key, certificate)], root_certificates=ca, require_client_auth=bool(args.ca))
            port = server.add_secure_port("127.0.0.1:0", credentials)
        else:
            port = server.add_insecure_port("127.0.0.1:0")
        server.start()
        emit({"endpoint": f"{'https' if secure else 'http'}://localhost:{port}"})
        server.wait_for_termination()
    else:
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        if secure:
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(args.certificate, args.key)
            if args.ca:
                context.load_verify_locations(args.ca)
                context.verify_mode = ssl.CERT_REQUIRED
            server.socket = context.wrap_socket(server.socket, server_side=True)
        readiness = {"endpoint": f"{'https' if secure else 'http'}://localhost:{server.server_port}"}
        if args.also_plain_http:
            plain = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            threading.Thread(target=plain.serve_forever, daemon=True).start()
            readiness["plainEndpoint"] = f"http://localhost:{plain.server_port}"
        emit(readiness)
        server.serve_forever()
