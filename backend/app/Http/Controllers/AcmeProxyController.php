<?php

namespace App\Http\Controllers;

use GuzzleHttp\Client as GuzzleClient;
use GuzzleHttp\Exception\RequestException;
use Illuminate\Http\Request;

class AcmeProxyController extends Controller
{
    private const ALLOWED_HOSTS = [
        'acme-v02.api.letsencrypt.org',
        'acme-staging-v02.api.letsencrypt.org',
        'acme.zerossl.com',
    ];

    public function forward(Request $request)
    {
        $targetUrl = $request->input('url', '');
        $method    = strtoupper($request->input('method', 'GET'));
        $headers   = $request->input('headers', []);
        $body      = $request->input('body', '');

        // Validate target host — only ACME endpoints allowed
        $host = parse_url($targetUrl, PHP_URL_HOST) ?: '';
        if (!in_array($host, self::ALLOWED_HOSTS, true)) {
            return response()->json(['error' => 'Forbidden host'], 403);
        }

        $options = [
            'timeout'         => 15,
            'allow_redirects' => true,
            'headers'         => $headers,
        ];

        if ($body !== '' && !in_array($method, ['GET', 'HEAD'], true)) {
            $options['body'] = $body;
        }

        try {
            $guzzle   = new GuzzleClient();
            $response = $guzzle->request($method, $targetUrl, $options);
        } catch (RequestException $e) {
            if ($e->hasResponse()) {
                $response = $e->getResponse();
            } else {
                return response()->json(['error' => $e->getMessage()], 502);
            }
        }

        // Forward only the ACME-relevant headers back to the Worker
        $forward = [];
        foreach (['Content-Type', 'Replay-Nonce', 'Location', 'Link'] as $h) {
            if ($response->hasHeader($h)) {
                $forward[$h] = $response->getHeaderLine($h);
            }
        }

        return response($response->getBody()->getContents(), $response->getStatusCode())
            ->withHeaders($forward);
    }
}
