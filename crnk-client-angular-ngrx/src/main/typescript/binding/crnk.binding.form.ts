import {Observable} from "rxjs/Observable";
import {Subscription} from "rxjs/Subscription";
import * as _ from "lodash";
import "rxjs/add/operator/zip";
import "rxjs/add/operator/do";
import "rxjs/add/operator/debounceTime";
import "rxjs/add/operator/distinct";
import "rxjs/add/operator/switch";
import "rxjs/add/operator/finally";
import "rxjs/add/operator/share";
import {AbstractControl, NgForm} from "@angular/forms";
import {OperationsService} from "../operations";
import {
	NgrxJsonApiService,
	NgrxJsonApiStoreData,
	Resource,
	ResourceError,
	ResourceIdentifier,
	StoreResource
} from "ngrx-json-api";
import {Store} from "@ngrx/store";
import {NgrxJsonApiSelectors} from "ngrx-json-api/src/selectors";


interface ResourceFieldRef {
	resourceId: ResourceIdentifier;
	path: String;
}

export interface FormBindingConfig {
	/**
	 * Reference to the forFormElement instance to hook into.
	 */
	form: NgForm;

	/**
	 * Reference to a query from the store to get notified about validation errors.
	 * FormBinding implementation assumes that the query has already been executed
	 * (typically when performing the route to a new page).
	 */
	queryId: string;

	/**
	 * JSON API errors get mapped to AbstractControl errors. The id resp. code of the JSON API error
	 * is used as key for the control error. This property specifies a prefix for that key. It allows
	 * to make use of JSON API errors next to other kinds of errors without influencing each other
	 * (updates of JSON API errors are synchronized to control errors with that prefix, other kinds of errors
	 * remain unaffected). by default 'jsonapi.` is used.
	 */
	controlErrorIdPrefix?: string;


	/**
	 * By default a denormalized selectOneResults is used to fetch resources. Any update of those
	 * resources triggers an update of the FormControl states. Set this flag to true to listen to all store changes.
	 */
	mapNonResultResources?: boolean;
}

/**
 * Binding between ngrx-jsonapi and angular forms. It serves two purposes:
 *
 * <ul>
 *     <li>Updates the JSON API store when forFormElement controls changes their values.</li>
 *     <li>Updates the validation state of forFormElement controls in case of JSON API errors. JSON API errors that cannot be
 *         mapped to a forFormElement control are hold in the errors property
 *     </li>
 * <ul>
 *
 * The binding between resources in the store and forFormElement controls happens trough the naming of the forFormElement
 * controls. Two naming patterns are supported:
 *
 * <ul>
 *     <li>basic binding for all forFormElement controls that start with "attributes." or "relationships.". A forFormElement
 * control with label "attributes.title" is mapped to the "title" attribute of the JSON API resource in the store. The id of the
 * resource is obtained from the FormBindingConfig.resource$.
 *     </li>
 *     <li>(not yet supported) advanced binding with the naming pattern
 * "resource.{type}.{id}.{attributes/relationships}.{label}".
 *     It allows to edit multiple resources in the same forFormElement.
 *     </li>
 * <ul>
 *
 * Similarly, JSON API errors are mapped back to forFormElement controls trougth the source pointer of the error. If such a
 * mapping is not found, the error is added to the errors attribute of this class. Usually applications show such errors above
 * all fields in the config.
 *
 * You may also have a look at the CrnkExpressionModule. Its ExpressionDirective provides an alternative to NgModel
 * that binds both a value and sets the label of forFormElement control with a single (type-safe) attribute.
 */
export class FormBinding {

	/**
	 * Observable to the resource to be edited. The forFormElement binding is active as long as there is
	 * at least one subscriber to this Observable.
	 */
	public resource$: Observable<StoreResource>;

	/**
	 * Contains all errors that cannot be assigned to a forFormElement control. Usually such errors are shown on top above
	 * all controls.
	 */
	public unmappedErrors: Array<ResourceError> = [];

	/**
	 * the forFormElement also sends out valueChanges upon initialization, we do not want that and filter them out with this flag
	 */
	private wasDirty = false;

	/**
	 * id of the main resource to be edited.
	 */
	private primaryResourceId: ResourceIdentifier = null;

	/**
	 * Subscription to forFormElement changes. Gets automatically cancelled if there are no subscriptions anymore to
	 * resource$.
	 */
	private formSubscription: Subscription = null;

	private storeSubscription: Subscription = null;

	private formControlsInitialized = false;

	private controlErrorIdPrefix = 'jsonapi.';

	constructor(private ngrxJsonApiService: NgrxJsonApiService, private config: FormBindingConfig,
				private operationsService: OperationsService, private store: Store<any>,
				private ngrxJsonApiSelectors: NgrxJsonApiSelectors<any>) {

		if (this.config.form === null) {
			throw new Error('no forFormElement provided');
		}
		if (this.config.queryId === null) {
			throw new Error('no queryId provided');
		}
		if (this.config.controlErrorIdPrefix) {
			this.controlErrorIdPrefix = this.config.controlErrorIdPrefix;
		}


		// we make use of share() to keep the this.config.resource$ subscription
		// as long as there is at least subscriber on this.resource$.
		this.resource$ = this.ngrxJsonApiService.selectOneResults(this.config.queryId, true)
			.filter(it => !it.loading)
			.map(it => it.data as StoreResource)
			.filter(it => !_.isEmpty(it)) // ignore deletions
			.distinctUntilChanged(function (a, b) {
				return _.isEqual(a, b);
			})
			.do(() => this.checkSubscriptions())
			.do(resource => this.primaryResourceId = {type: resource.type, id: resource.id})
			.do(() => this.mapResourceToControlErrors())
			.finally(() => this.cancelSubscriptions)
			.share();

	}

	protected cancelSubscriptions() {
		if (this.formSubscription !== null) {
			this.formSubscription.unsubscribe();
			this.formSubscription = null;
		}
		if (this.storeSubscription !== null) {
			this.storeSubscription.unsubscribe();
			this.storeSubscription = null;
		}
	}

	private get storeDataSnapshot(): NgrxJsonApiStoreData {
		return this.ngrxJsonApiService['storeSnapshot']['data'] as NgrxJsonApiStoreData;
	}


	protected checkSubscriptions() {
		if (this.formSubscription === null) {
			// update store from value changes, for more information see
			// https://embed.plnkr.co/9aNuw6DG9VM4X8vUtkAa?show=app%2Fapp.components.ts,preview
			const formChanges$ = this.config.form.statusChanges
				.filter(valid => valid === 'VALID')
				.do(() => {
					// it may take a moment for a form with all controls to initialize and register.
					// there seems no proper Angular lifecycle for this to check(???). Till no
					// control is found, we perform the mapping also here.
					//
					// geting notified about new control would be great...
					if(!this.formControlsInitialized){
						this.mapResourceToControlErrors();
					}
				})

				.withLatestFrom(this.config.form.valueChanges, (valid, values) => values)
				.filter(it => this.config.form.dirty || this.wasDirty)
				.debounceTime(20)
				.distinctUntilChanged(function (a, b) {
					return _.isEqual(a, b);
				})
				.do(it => this.wasDirty = true);
			this.formSubscription = formChanges$.subscribe(formValues => this.updateStoreFromFormValues(formValues));
		}

		if (this.storeSubscription != null && this.config.mapNonResultResources) {
			this.storeSubscription = this.store
				.let(this.ngrxJsonApiSelectors.getNgrxJsonApiStore$())
				.let(this.ngrxJsonApiSelectors.getStoreData$())
				.subscribe(data => {
					this.mapResourceToControlErrors();
				});
		}
	}

	private collectNonJsonApiControlErrors(control: AbstractControl) {
		let controlErrors = {};
		let otherErrorKeys = _.keys(control.errors).filter(it => !it.startsWith(this.controlErrorIdPrefix));
		for (let otherErrorKey in otherErrorKeys) {
			if(control.errors.hasOwnProperty(otherErrorKey)) {
				controlErrors[otherErrorKey] = control.errors[otherErrorKey];
			}
		}
		return controlErrors;
	}

	private computeControlErrorKey(error: ResourceError) {
		return error.code ? error.code : error.id;
	}

	protected mapResourceToControlErrors() {

		for (let formName in this.config.form.controls) {
			this.formControlsInitialized = true;

			let control = this.config.form.controls[formName];

			let fieldRef = this.parseResourceFieldRef(formName);
			let sourcePointer = '/data/' + fieldRef.path.replace(new RegExp('\\.', 'g'), '/');
			let resource = this.storeDataSnapshot[fieldRef.resourceId.type][fieldRef.resourceId.id];

			if (resource) {
				const controlErrors = this.collectNonJsonApiControlErrors(control);
				for (const resourceError of resource.errors) {
					let errorKey = this.computeControlErrorKey(resourceError);
					if (resourceError.source && sourcePointer == resourceError.source.pointer && errorKey) {
						controlErrors[this.controlErrorIdPrefix + errorKey] = resourceError;
					}
				}
				control.setErrors(controlErrors);
			}
		}

		let form = this.config.form;
		if (this.primaryResourceId) {
			let primaryResource = this.storeDataSnapshot[this.primaryResourceId.type][this.primaryResourceId.id];

			const newUnmappedErrors = [];
			for (const resourceError of primaryResource.errors) {
				let errorKey = this.computeControlErrorKey(resourceError);
				if (resourceError.source && resourceError.source.pointer && errorKey) {
					const path = this.toPath(resourceError.source.pointer);
					const formName = this.toResourceFormName(primaryResource, path);
					if (!form.controls[formName] && !form.controls[path]) {
						newUnmappedErrors.push(resourceError);
					}
				}
			}
			this.unmappedErrors = newUnmappedErrors;
		}
	}

	protected toResourceFormName(resource: StoreResource, basicFormName: string) {
		return '//' + resource.type + '//' + resource.id + '//' + basicFormName;
	}

	protected toPath(sourcePointer: string) {
		let formName = sourcePointer.replace(new RegExp('/', 'g'), '.');
		if (formName.startsWith('.')) {
			formName = formName.substring(1);
		}
		if (formName.endsWith('.')) {
			formName = formName.substring(0, formName.length - 1);
		}
		if (formName.startsWith('data.')) {
			formName = formName.substring(5);
		}
		return formName;
	}

	public save() {
		// TODO Collect resources to update
		if (this.operationsService) {
			// transactional update of multple resources
			this.operationsService.apply();
		}
		else {
			this.ngrxJsonApiService.apply();
		}
	}

	public delete() {
		this.ngrxJsonApiService.deleteResource({
				resourceId: this.primaryResourceId,
				toRemote: true
			}
		);
	}

	/**
	 * computes type, id and field path from formName.
	 */
	private parseResourceFieldRef(formName: string): ResourceFieldRef {
		if (formName.startsWith('//')) {
			let [type, id, path] = formName.substring(2).split('//');
			return {
				resourceId: {
					type: type,
					id: id
				},
				path: path
			}
		}
		else {
			return {
				resourceId: {
					type: this.primaryResourceId.type,
					id: this.primaryResourceId.id
				},
				path: formName
			}
		}
	}

	public updateStoreFromFormValues(values: any) {
		const patchedResourceMap: { [id: string]: Resource } = {};
		for (const formName of Object.keys(values)) {
			const value = values[formName];

			let formRef = this.parseResourceFieldRef(formName);
			if (formRef.path.startsWith('attributes.') || formRef.path.startsWith('relationships.')) {
				const key = formRef.resourceId.type + '_' + formRef.resourceId.id;
				let patchedResource = patchedResourceMap[key];
				if (!patchedResource) {
					patchedResource = {
						id: formRef.resourceId.id,
						type: formRef.resourceId.type,
						attributes: {}
					};
					patchedResourceMap[key] = patchedResource;
				}
				_.set(patchedResource, formRef.path, value);
			}
		}

		const patchedResources = _.values(patchedResourceMap);
		for (const patchedResource of patchedResources) {
			const cleanedPatchedResource = this.clearPrimeNgMarkers(patchedResource);
			this.ngrxJsonApiService.patchResource({resource: cleanedPatchedResource});
		}
	}

	/**
	 * Prime NG has to annoying habit of adding _$visited. Cleaned up here. Needs to be further investigated
	 * and preferably avoided.
	 *
	 * FIXME move to HTTP layer or fix PrimeNG, preferably the later.
	 */
	private clearPrimeNgMarkers(resource: Resource) {
		const cleanedResource = _.cloneDeep(resource);
		if (cleanedResource.attributes) {
			for (const attributeName of Object.keys(cleanedResource.attributes)) {
				const value = cleanedResource.attributes[attributeName];
				if (_.isObject(value)) {
					delete value['_$visited'];
				}
			}
		}
		if (cleanedResource.relationships) {
			for (const relationshipName of Object.keys(cleanedResource.relationships)) {
				const relationship = cleanedResource.relationships[relationshipName];
				if (relationship.data) {
					const dependencyIds: Array<ResourceIdentifier> = relationship.data instanceof Array ? relationship.data :
						[relationship.data];
					for (const dependencyId of dependencyIds) {
						delete dependencyId['_$visited'];
					}
				}
			}
		}
		return cleanedResource;
	}
}
