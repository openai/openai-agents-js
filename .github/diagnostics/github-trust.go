package main

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"runtime"
	"sync/atomic"
	"time"
)

const target = "https://api.github.com/"
const stockPEM = "/etc/ssl/cert.pem"

var loopback = regexp.MustCompile(`^http://(127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}/?$`)
var osStatus = regexp.MustCompile(`\bOSStatus\s+(-?[0-9]{1,10})\b`)

type receipt struct {
	Go            string     `json:"go"`
	Mode          string     `json:"mode"`
	Connect       int        `json:"connect"`
	HTTP          int        `json:"http"`
	Outcome       string     `json:"outcome"`
	OSStatus      string     `json:"osStatus,omitempty"`
	PEMSHA256     string     `json:"pemSha256,omitempty"`
	PeerSHA256    []string   `json:"peerSha256,omitempty"`
	VerifiedChain [][]string `json:"verifiedChainsSha256,omitempty"`
}

func fingerprints(certs []*x509.Certificate) []string {
	hashes := make([]string, 0, len(certs))
	for _, cert := range certs {
		sum := sha256.Sum256(cert.Raw)
		hashes = append(hashes, hex.EncodeToString(sum[:]))
	}
	return hashes
}

func probe(mode string) receipt {
	result := receipt{Go: runtime.Version(), Mode: mode, Outcome: "invalid-proxy"}
	proxy := os.Getenv("HTTPS_PROXY")
	if !loopback.MatchString(proxy) {
		return result
	}
	proxyURL, err := url.Parse(proxy)
	if err != nil {
		return result
	}

	config := &tls.Config{}
	if mode == "pem" {
		pem, err := os.ReadFile(stockPEM)
		if err != nil {
			result.Outcome = "pem-read-failed"
			return result
		}
		sum := sha256.Sum256(pem)
		result.PEMSHA256 = hex.EncodeToString(sum[:])
		config.RootCAs = x509.NewCertPool()
		if !config.RootCAs.AppendCertsFromPEM(pem) {
			result.Outcome = "pem-parse-failed"
			return result
		}
	}

	var connect atomic.Int32
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = http.ProxyURL(proxyURL)
	transport.DisableKeepAlives = true
	transport.TLSClientConfig = config
	transport.OnProxyConnectResponse = func(_ context.Context, _ *url.URL, _ *http.Request, response *http.Response) error {
		connect.Store(int32(response.StatusCode))
		return nil
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{
		Transport: transport,
		Timeout:   8 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	response, err := client.Get(target)
	result.Connect = int(connect.Load())
	if err != nil {
		result.Outcome = "transport-error"
		var certErr *tls.CertificateVerificationError
		if errors.As(err, &certErr) {
			result.Outcome = "certificate-verification-failed"
			result.PeerSHA256 = fingerprints(certErr.UnverifiedCertificates)
			if match := osStatus.FindStringSubmatch(certErr.Err.Error()); len(match) == 2 {
				result.OSStatus = match[1]
			}
		}
		return result
	}
	defer response.Body.Close()
	result.HTTP = response.StatusCode
	if response.TLS == nil || len(response.TLS.VerifiedChains) == 0 {
		result.Outcome = "missing-verified-chain"
		return result
	}
	result.Outcome = "verified"
	result.PeerSHA256 = fingerprints(response.TLS.PeerCertificates)
	for _, chain := range response.TLS.VerifiedChains {
		result.VerifiedChain = append(result.VerifiedChain, fingerprints(chain))
	}
	return result
}

func main() {
	if len(os.Args) != 2 || (os.Args[1] != "system" && os.Args[1] != "pem") {
		os.Exit(2)
	}
	if err := json.NewEncoder(os.Stdout).Encode(probe(os.Args[1])); err != nil {
		os.Exit(2)
	}
}
