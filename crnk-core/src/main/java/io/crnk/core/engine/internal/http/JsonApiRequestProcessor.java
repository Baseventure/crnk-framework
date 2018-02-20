package io.crnk.core.engine.internal.http;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.google.common.collect.Lists;

import io.crnk.core.boot.CrnkProperties;
import io.crnk.core.engine.dispatcher.RequestDispatcher;
import io.crnk.core.engine.dispatcher.Response;
import io.crnk.core.engine.document.Document;
import io.crnk.core.engine.document.ErrorData;
import io.crnk.core.engine.http.HttpHeaders;
import io.crnk.core.engine.http.HttpMethod;
import io.crnk.core.engine.http.HttpRequestContext;
import io.crnk.core.engine.http.HttpRequestProcessor;
import io.crnk.core.engine.internal.dispatcher.path.ActionPath;
import io.crnk.core.engine.internal.dispatcher.path.JsonPath;
import io.crnk.core.engine.internal.dispatcher.path.PathBuilder;
import io.crnk.core.engine.registry.ResourceRegistry;
import io.crnk.core.module.Module;
import io.crnk.legacy.internal.RepositoryMethodParameterProvider;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.util.Map;
import java.util.Set;

public class JsonApiRequestProcessor implements HttpRequestProcessor {

	private static final Logger LOGGER = LoggerFactory.getLogger(JsonApiRequestProcessor.class);


	private Module.ModuleContext moduleContext;
	private Boolean acceptingPlainJson;

	public JsonApiRequestProcessor(Module.ModuleContext moduleContext) {
		this.moduleContext = moduleContext;
	}

	/**
	 * Determines whether the supplied HTTP request is considered a JSON-API request. Accepts plain JSON requests by default.
	 * @see #isJsonApiRequest(HttpRequestContext, boolean)
	 * @param requestContext The HTTP request
	 * @return <code>true</code> if it is a JSON-API request; <code>false</code> otherwise
	 */
	@Deprecated
	public static boolean isJsonApiRequest(HttpRequestContext requestContext) {
		return isJsonApiRequest(requestContext, true);
	}

	/**
	 * Determines whether the supplied HTTP request is considered a JSON-API request.
	 * @param requestContext The HTTP request
	 * @param acceptPlainJson Whether a plain JSON request should also be considered a JSON-API request
	 * @return <code>true</code> if it is a JSON-API request; <code>false</code> otherwise
	 * @since 2.4
	 */
	@SuppressWarnings("UnnecessaryLocalVariable")
	public static boolean isJsonApiRequest(HttpRequestContext requestContext, boolean acceptPlainJson) {
		if (requestContext.getMethod().equalsIgnoreCase(HttpMethod.PATCH.toString()) || requestContext.getMethod()
				.equalsIgnoreCase(HttpMethod.POST.toString())) {
			String contentType = requestContext.getRequestHeader(HttpHeaders.HTTP_CONTENT_TYPE);
			if (contentType == null || !contentType.startsWith(HttpHeaders.JSONAPI_CONTENT_TYPE)) {
				return false;
			}
		}

		// short-circuit each of the possible Accept MIME type checks, so that we don't keep comparing after we have already
		// found a match. Intentionally kept as separate statements (instead of a big, chained ||) to ease debugging/maintenance.
		boolean acceptsJsonApi = requestContext.accepts(HttpHeaders.JSONAPI_CONTENT_TYPE);
		boolean acceptsAny = acceptsJsonApi || requestContext.acceptsAny();
		boolean acceptsPlainJson = acceptsAny || (acceptPlainJson && requestContext.accepts("application/json"));
		return acceptsPlainJson;
	}

	private boolean isAcceptingPlainJson() {
		if(acceptingPlainJson == null){
			acceptingPlainJson = !Boolean.parseBoolean(moduleContext.getPropertiesProvider().getProperty(CrnkProperties.REJECT_PLAIN_JSON));
		}
		return acceptingPlainJson;
	}

	@Override
	public void process(HttpRequestContext requestContext) throws IOException {
		if (isJsonApiRequest(requestContext, isAcceptingPlainJson())) {

			ResourceRegistry resourceRegistry = moduleContext.getResourceRegistry();
			RequestDispatcher requestDispatcher = moduleContext.getRequestDispatcher();

			String path = requestContext.getPath();

			JsonPath jsonPath = new PathBuilder(resourceRegistry).build(path);
			Map<String, Set<String>> parameters = requestContext.getRequestParameters();
			String method = requestContext.getMethod();

			if (jsonPath instanceof ActionPath) {
				// inital implementation, has to improve
				requestDispatcher.dispatchAction(path, method, parameters);
			} else if (jsonPath != null) {
				byte[] requestBody = requestContext.getRequestBody();

				Document document = null;
				if (requestBody != null && requestBody.length > 0) {
					ObjectMapper objectMapper = moduleContext.getObjectMapper();
					try {
						document = objectMapper.readerFor(Document.class).readValue(requestBody);
					} catch (JsonProcessingException e ) {
						final String message = "Json Parsing failed";
						setResponse(requestContext, buildBadRequestResponse(message, e.getMessage()));
						LOGGER.error(message, e);
						return;
					}
				}

				RepositoryMethodParameterProvider parameterProvider = requestContext.getRequestParameterProvider();
				Response crnkResponse = requestDispatcher
						.dispatchRequest(path, method, parameters, parameterProvider, document);
				setResponse(requestContext, crnkResponse);
			} else {
				// no repositories invoked, we do nothing
			}
		}
	}

	private Response buildBadRequestResponse(final String message, final String detail) {
		Document responseDocument = new Document();
		responseDocument.setErrors(Lists.newArrayList(ErrorData.builder()
				.setStatus(String.valueOf(400))
				.setTitle(message)
				.setDetail(detail)
				.build()));
		return new Response(responseDocument, 400);
	}

	private void setResponse(HttpRequestContext requestContext, Response crnkResponse)
			throws IOException {
		if (crnkResponse != null) {
			ObjectMapper objectMapper = moduleContext.getObjectMapper();
			String responseBody = objectMapper.writeValueAsString(crnkResponse.getDocument());

			requestContext.setResponseHeader("Content-Type", HttpHeaders.JSONAPI_CONTENT_TYPE_AND_CHARSET);
			requestContext.setResponse(crnkResponse.getHttpStatus(), responseBody);
		}
	}

}
